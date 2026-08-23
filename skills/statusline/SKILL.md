---
description: Add a live pi dispatch indicator to the Claude Code status line, composed with whatever status line the user already has
disable-model-invocation: true
---

The user wants the pi indicator in their status line: $ARGUMENTS

`statusLine` is a **single global field** in `~/.claude/settings.json`. There is exactly one,
and a plugin cannot ship its own — the plugin `settings.json` supports only `agent` and
`subagentStatusLine`. So there is no way to add this without writing to the user's settings,
and every step below exists because of that: whatever is already there is theirs, it is
probably the only status line they have, and replacing it is not a thing to do quietly.

Work through this with them. Do not run it end to end and report afterwards.

## 1. Find out what is already there

```bash
python3 -c "
import json, os
p = os.path.expanduser('~/.claude/settings.json')
d = json.load(open(p)) if os.path.exists(p) else {}
print(json.dumps(d.get('statusLine', None), indent=2))
print('refreshInterval:', (d.get('statusLine') or {}).get('refreshInterval', '(unset)'))
"
```

**If the command contains `pi-delegate/statusline-wrapper.sh`, it is already ours.** Stop and
go to step 6 (update in place). Wrapping a wrapper is the obvious way to end up running the
user's real status line twice, and then four times.

## 2. Probe it — do not reason about it

Whatever is there, run it and look. It gets a JSON payload on stdin, so give it one:

```bash
printf '%s' '{"session_id":"probe","cwd":"'"$PWD"'","model":{"id":"claude-opus-5","display_name":"Opus 5"},"workspace":{"current_dir":"'"$PWD"'","project_dir":"'"$PWD"'"},"version":"2.0.0","context_window":{"used_percentage":25}}' \
  | <their command> > /tmp/pi-probe.out 2>/tmp/pi-probe.err
echo "exit=$?  lines=$(wc -l < /tmp/pi-probe.out)"
cat /tmp/pi-probe.out
```

This is the whole reason the composition is safe for people whose setup you have never seen.
You are not guessing at ccstatusline, starship, powerline or a personal shell script — you are
looking at the bytes it produced. Note the line count; that is what the "after" preview needs.

Then show them their pi segment, on its own:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/statusline.sh"
```

If nothing is running it prints nothing, which is correct and worth saying out loud — the row
only exists while a dispatch is in flight. To show them what it will look like, fake one:

```bash
mkdir -p ~/.claude/pi-delegate/status
echo "pid=$$ running=2 oldest=$(( $(date +%s) - 192 )) updated=$(date +%s) models=Qwen3.8-27B" \
  > ~/.claude/pi-delegate/status/preview.status
"${CLAUDE_PLUGIN_ROOT}/scripts/statusline.sh"
rm ~/.claude/pi-delegate/status/preview.status
```

Show them **before and after** — their real output, then their real output with the pi row
under it — and ask before writing anything.

## 3. Say what it costs, before they answer

Two things, and neither is obvious from the preview:

- **`refreshInterval` is required, not decorative.** Without it the status line only reruns on
  conversation events, and those go quiet exactly when an async dispatch is running and the
  session is idle — which is the entire case this feature exists for. The recommended value is
  `2` seconds.
- **`refreshInterval` reruns the whole thing, including their existing status line.** If theirs
  shells out to `git` (most do), that is now running every 2 seconds for as long as Claude Code
  is open. On this machine a full powerline render measured ~100ms, so 2 seconds is about 5% of
  one core, continuously. If their probe in step 2 was slow, tell them the number you measured
  and offer `3` instead.

If they would rather not have the timer, the indicator still works — it just only updates when
something else already caused a redraw. Say that plainly rather than talking them into the timer.

## 4. Install their own copy of the segment

Copy the script to a stable path instead of pointing settings at the plugin:

```bash
mkdir -p ~/.claude/pi-delegate
cp "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.sh" ~/.claude/pi-delegate/statusline.sh
chmod +x ~/.claude/pi-delegate/statusline.sh
```

The plugin's own path carries its version (`.../pi-delegate/0.12.0/...`) and every release gets
a new directory, so a `settings.json` pointing into it breaks on the next `/plugin update` —
silently, because a status line that fails just doesn't render.

**This copy is also where the user's taste goes.** The script separates gathering from
rendering: everything above `render` collects `$running`, `$sessions`, `$elapsed` and `$models`,
and `render` alone decides what they look like. If they want different wording, no breathing
dot, a different colour, their own glyphs — edit `render` in their copy. Offer this; it is the
point of the file being shaped that way. Leave everything above it alone.

## 5. Compose, back up, and write

Back up first, with a timestamp, and tell them the path:

```bash
cp ~/.claude/settings.json ~/.claude/settings.json.bak.$(date +%Y%m%d-%H%M%S)
```

Write the wrapper. Substitute their real command into `PI_DELEGATE_ORIGINAL` (single-quoted,
with any embedded `'` escaped as `'\''`), or leave it empty if they had no status line:

```bash
cat > ~/.claude/pi-delegate/statusline-wrapper.sh <<'WRAPPER'
#!/usr/bin/env bash
# Generated by /pi-delegate:statusline. Runs the status line that was configured before
# pi-delegate touched it, then appends the pi row underneath when a dispatch is running.
#
# To restore the original: put PI_DELEGATE_ORIGINAL back as settings.json's
# statusLine.command, or just run /pi-delegate:statusline and ask to remove it.
PI_DELEGATE_ORIGINAL=''

# Deliberately NO `set -e`. The two halves must not be able to take each other down: a
# broken status line is present on every screen the user looks at, so a failure in one half
# has to degrade to "that half is missing", never to an empty bar.

# stdin can only be read once, and both halves want it.
input=$(cat)

if [ -n "$PI_DELEGATE_ORIGINAL" ]; then
  printf '%s' "$input" | eval "$PI_DELEGATE_ORIGINAL" || true
fi

# Prints nothing at all unless a pi dispatch is running, so this row costs no height when
# there is nothing to say.
[ -x "$HOME/.claude/pi-delegate/statusline.sh" ] && "$HOME/.claude/pi-delegate/statusline.sh" || true

exit 0
WRAPPER
chmod +x ~/.claude/pi-delegate/statusline-wrapper.sh
```

Then point settings at it, preserving every other key:

```bash
python3 - <<'PY'
import json, os
p = os.path.expanduser('~/.claude/settings.json')
d = json.load(open(p)) if os.path.exists(p) else {}
d['statusLine'] = {
    'type': 'command',
    'command': os.path.expanduser('~/.claude/pi-delegate/statusline-wrapper.sh'),
    'refreshInterval': 2,
}
json.dump(d, open(p, 'w'), indent=2)
open(p, 'a').write('\n')
print('statusLine ->', d['statusLine'])
PY
```

Verify by running the wrapper the same way Claude Code will, and show them the result:

```bash
printf '%s' '{"session_id":"probe","cwd":"'"$PWD"'","model":{"display_name":"Opus 5"},"workspace":{"current_dir":"'"$PWD"'","project_dir":"'"$PWD"'"}}' \
  | ~/.claude/pi-delegate/statusline-wrapper.sh
```

If that prints their original status line unchanged, the composition worked. The pi row appears
on the next real dispatch. Tell them it takes effect immediately — no reload needed.

## 6. Updating or removing it later

**Updating after a plugin upgrade:** re-run step 4's `cp`. Warn them first if they edited
`render` — the copy is theirs, and overwriting it silently would throw their work away. Diff it
against the plugin's version and let them decide.

**Removing it:** read `PI_DELEGATE_ORIGINAL` out of the wrapper, put it back as
`statusLine.command`, and drop `refreshInterval` if they did not have one before (check the
backup). If `PI_DELEGATE_ORIGINAL` is empty they had no status line, so remove the `statusLine`
key entirely rather than leaving one that prints only pi rows.

## What this deliberately does not do

It does not put pi into the subagent panel below the prompt. `subagentStatusLine` can only
override the rows Claude Code already renders for its own subagents — override one by `id`,
or hide it with an empty string. There is no way to add a row, and a pi dispatch is not a
Claude Code subagent. The main status line is the only surface available, so the pi row
imitates that style rather than living there.
