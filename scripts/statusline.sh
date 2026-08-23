#!/usr/bin/env bash
#
# The pi segment of a Claude Code status line. Prints ONE line when a pi dispatch is
# running anywhere on this machine, and prints NOTHING at all when nothing is running —
# which is what lets it be appended to any existing status line without taking up a row
# it has not earned.
#
# This file is also the template. It is meant to be copied and edited: everything above
# `render` gathers facts, `render` decides what they look like. Change `render`, leave the
# rest alone, and nothing can break except the appearance.
#
# Run it by hand to see it:  PI_DELEGATE_STATUS_DIR=... ./statusline.sh
#
# Why bash and not node: this runs on every status-line tick. Measured on this machine, a
# node process that does nothing but read one small file costs 40-60ms of interpreter
# startup, against ~100ms for a full powerline render — a 50% latency increase for one
# line of text. Reading the flat `key=value` format below in bash is unmeasurable.

STATUS_DIR="${PI_DELEGATE_STATUS_DIR:-$HOME/.claude/pi-delegate/status}"

# ---------------------------------------------------------------- gather
#
# One file per Claude Code session (src/status.mjs writes them), and this counts ONLY the
# one belonging to the session it is rendering for.
#
# 0.13.0 summed across sessions, reasoning that every pi reaches the same endpoint so the
# machine-wide number is the useful one. That was wrong in practice: the other window
# showed `1 running` for a dispatch its own pi_result answers "Unknown session_id" to — a
# count you can see and cannot act on, in a session that dispatched nothing.
#
# Line 2 of each status file is its owner: the raw CLAUDE_CODE_MESSAGING_SOCKET of the
# session that wrote it. Claude Code puts that same value in this script's environment
# (verified), so ownership is a string comparison — no hashing, no subprocess, and a path
# containing a space is safe because the owner has a whole line to itself.
OWNER="${PI_DELEGATE_OWNER:-${CLAUDE_CODE_MESSAGING_SOCKET:-}}"

# Liveness needs a pid this shell can actually resolve, and on Windows it cannot. The pid
# in a status file is node's `process.pid` — a WINDOWS pid — while Git Bash's `kill` only
# resolves pids in the MSYS namespace. The two are unrelated numbers, so the gate below
# rejected every status file and the pi row never rendered on Windows at all.
#
# `ps -W` is the MSYS escape hatch: it lists native Windows processes with the winpid in
# column 4. Snapshot it ONCE per tick rather than per file — one fork on Windows, none
# anywhere else, and the loop below stays free of subprocesses either way.
WINPIDS=""
case "${OSTYPE:-}" in
  msys*|cygwin*) WINPIDS=" $(ps -W 2>/dev/null | awk 'NR>1 && $4 ~ /^[0-9]+$/ {printf "%s ", $4}')" ;;
esac

# One row per running dispatch, newline separated, each row "started count model".
#
# `count` is 1 for a row that came from a per-dispatch line. It is only ever greater
# against an OLDER writer, whose file carries just the aggregate — so the count travels
# with the row instead of becoming a second code path in the renderer.
NL=$'\n'
ROWS=""
ROW_COUNT=0

running=0

if [ -d "$STATUS_DIR" ]; then
  for f in "$STATUS_DIR"/*.status; do
    # An unmatched glob comes through as the literal pattern.
    [ -f "$f" ] || continue

    pid=""; r=0; o=0; m=""; file_owner=""; line=""; detail=""
    # Lines 1 and 2 are the aggregate and the owner; everything after is one line per
    # dispatch. Read in this shell, not a pipeline, or every variable set here is lost.
    n=0
    while IFS= read -r ln || [ -n "$ln" ]; do
      n=$(( n + 1 ))
      case "$n" in
        1) line="$ln" ;;
        2) file_owner="$ln" ;;
        *) [ -z "$ln" ] || detail="${detail}${ln}${NL}" ;;
      esac
    done < "$f"
    [ -n "$line" ] || continue

    # With no owner of our own — run by hand, or an older Claude Code — there is nothing to
    # compare against and no second session to be confused with, so count everything. With
    # one, require an exact match: a file we cannot attribute is not ours to report.
    if [ -n "$OWNER" ] && [ "$file_owner" != "$OWNER" ]; then
      continue
    fi

    for kv in $line; do
      case "$kv" in
        pid=*)     pid="${kv#pid=}" ;;
        running=*) r="${kv#running=}" ;;
        oldest=*)  o="${kv#oldest=}" ;;
        models=*)  m="${kv#models=}" ;;
      esac
    done

    # Every numeric field is validated before it reaches arithmetic. This file is written
    # by our own server, but a half-written or hand-edited one must degrade to "skip it",
    # never to a bash error printed into the user's status bar.
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    case "$r"   in ''|*[!0-9]*) continue ;; esac
    case "$o"   in    *[!0-9]*) continue ;; esac

    # The liveness gate. A server that was killed rather than shut down leaves its file
    # behind; its pid is the proof of whether that count still means anything.
    if ! kill -0 "$pid" 2>/dev/null; then
      # Not in our namespace. On Windows that proves nothing, so consult the winpid
      # snapshot; everywhere else WINPIDS is empty and this stays a plain reject.
      case "$WINPIDS" in
        *" $pid "*) ;;
        *) continue ;;
      esac
    fi

    [ "$r" -gt 0 ] || continue

    running=$(( running + r ))

    if [ -n "$detail" ]; then
      # Per-dispatch lines, already sorted oldest-first by the writer.
      #
      # Note what is deliberately NOT done here: two dispatches on the same model are no
      # longer collapsed into one entry. They used to be, because a single row could only
      # show one elapsed time and repeating the model name bought nothing. A row each is
      # the whole point now — the same model started ten minutes apart is two facts.
      while IFS= read -r d; do
        [ -n "$d" ] || continue
        d_started=""; d_model="-"
        for kv in $d; do
          case "$kv" in
            started=*) d_started="${kv#started=}" ;;
            model=*)   d_model="${kv#model=}" ;;
          esac
        done
        case "$d_started" in ''|*[!0-9]*) continue ;; esac
        [ -n "$d_model" ] || d_model="-"
        ROWS="${ROWS}${d_started} 1 ${d_model}${NL}"
        ROW_COUNT=$(( ROW_COUNT + 1 ))
      done <<EOF
$detail
EOF
    else
      # Version skew: an older server wrote the aggregate and nothing else. One summary
      # row carrying the count is all that data supports, and it is exactly what this
      # script printed for its whole life before per-dispatch rows existed. Silence would
      # be the worse failure — see the Windows liveness bug, where nothing rendered and
      # nothing said so.
      [ -n "$m" ] || m="-"
      ROWS="${ROWS}${o} ${r} ${m}${NL}"
      ROW_COUNT=$(( ROW_COUNT + 1 ))
    fi
  done
fi

# Nothing running: no line, no blank row, no trace.
[ "$running" -gt 0 ] || exit 0
[ "$ROW_COUNT" -gt 0 ] || exit 0

# Oldest first, across every file. The writer already sorts within one file, so this only
# earns its fork when rows came from more than one — the hand-run and preview path, where
# no owner is set and every session's file is read. It matters because MAX_ROWS below
# DISCARDS rows: dropping the newest few is a choice, dropping whichever happened to be
# concatenated last is an accident. `started` is the first field, so a numeric sort on the
# line is a sort on the clock.
if [ "$ROW_COUNT" -gt 1 ]; then
  ROWS=$(printf '%s' "$ROWS" | sort -n)
fi

# PI_DELEGATE_NOW pins the clock. It exists so the breathing animation can be tested
# deterministically, and so you can preview any moment while editing `render` below:
#
#   PI_DELEGATE_NOW=$(( $(date +%s) + 5 )) ./statusline.sh
#
now="${PI_DELEGATE_NOW:-$(date +%s)}"
case "$now" in ''|*[!0-9]*) now=$(date +%s) ;; esac

# ---------------------------------------------------------------- helpers

fmt_elapsed() {
  if   [ "$1" -lt 60 ];   then printf '%ds' "$1"
  elif [ "$1" -lt 3600 ]; then printf '%dm%02ds' $(( $1 / 60 )) $(( $1 % 60 ))
  else                         printf '%dh%02dm' $(( $1 / 3600 )) $(( ($1 % 3600) / 60 ))
  fi
}

# The breathing dot.
#
# Claude Code reruns the status line on conversation events, plus a `refreshInterval`
# timer if one is set. The phase is therefore taken from the WALL CLOCK rather than from a
# frame counter: the animation then looks the same whatever cadence we are actually called
# at, and it does not freeze into one frame if the session goes quiet.
#
# A 10-second triangle. Slower than a real spinner on purpose — this is a "still alive"
# signal sitting in the corner of the screen for minutes at a time, and anything faster
# reads as an alarm.
breathing_dot() {
  local phase=$(( now % 10 ))
  if [ "$1" = "truecolor" ]; then
    local ramp=(90 119 148 177 206 235 206 177 148 119)
    local v=${ramp[$phase]}
    printf '\033[38;2;%d;%d;%dm●\033[0m' "$v" "$v" "$v"
  else
    # No truecolor: three glyph steps instead of 256 brightness steps. Same shape, coarser.
    local ramp=(0 0 1 1 2 2 2 1 1 0)
    local glyphs=('·' '•' '●')
    printf '\033[2m%s\033[0m' "${glyphs[${ramp[$phase]}]}"
  fi
}

# Truecolor is what makes the dot BREATHE. The basic path has three glyph steps at a
# constant dim; the truecolor path is one glyph at 256 brightness levels, and only the
# second reads as breathing at all. So a terminal misdetected as basic does not lose a
# little polish — it loses the feature, and looks like a static dot that someone forgot to
# animate. That was reported as "the breathing light is gone".
#
# `COLORTERM` is the right answer when it is there, but it is an unstandardised convention
# that a terminal exports for its own shell — and it does not always survive the trip into
# a child process spawned by an app, which is exactly what a status-line command is. Ghostty
# is the case that surfaced this: 24-bit capable, `TERM=xterm-ghostty`, no `COLORTERM`.
#
# So `TERM` is consulted as a fallback, and deliberately as a WHITELIST rather than a guess.
# Guessing wrong in the other direction prints `[38;2;90;90;90m` as literal text across the
# bottom of someone's terminal on every redraw, which is far worse than a dim dot. Anything
# not named here keeps the glyph path.
#
# Apple_Terminal is excluded on purpose: it is 256-colour only, and it is the reason this is
# not just "any TERM_PROGRAM that looks like a modern terminal".
color_mode() {
  case "$COLORTERM" in
    truecolor|24bit) printf 'truecolor'; return ;;
  esac

  # `*-direct` is the terminfo convention for a direct-colour entry (xterm-direct,
  # tmux-direct, alacritty-direct …), so it is a statement of capability, not a brand.
  case "$TERM" in
    *-direct|*-truecolor)
      printf 'truecolor'; return ;;
    xterm-ghostty|ghostty|xterm-kitty|alacritty|wezterm|contour|foot|foot-extra|rio)
      printf 'truecolor'; return ;;
  esac

  case "$TERM_PROGRAM" in
    ghostty|WezTerm|iTerm.app|vscode) printf 'truecolor'; return ;;
  esac

  printf 'basic'
}

# The dot is identical on every row — its phase comes from the wall clock, not from a
# per-row counter — so it is computed once here rather than forked per row. Rows pulsing
# in unison also reads as one indicator rather than several competing ones.
DOT=$(breathing_dot "$(color_mode)")
ESC=$'\033'
DIM="${ESC}[2m"
OFF="${ESC}[0m"
YELLOW="${ESC}[33m"
RED="${ESC}[31m"

# ---------------------------------------------------------------- render
#
# THIS IS THE PART YOU CHANGE. `render_row` is called once per running dispatch, with:
#
#   $1  started   epoch seconds this dispatch began (0 when the writer did not know)
#   $2  count     1 for a real dispatch; higher only for an older writer's aggregate row
#   $3  model     provider prefix already stripped, guaranteed free of spaces
#   $DOT          the breathing dot, already rendered for this tick
#   $now          the clock, pinnable via PI_DELEGATE_NOW
#
# Keep each row to ONE line. Rows are capped at MAX_ROWS, and a render that emitted two
# lines per dispatch would blow the status bar's height budget past that cap silently.

MAX_ROWS=4

# The duration sits in a fixed-width right-aligned column so the model names line up down
# the rows. That is the reason there are no `·` separators any more: with several rows the
# eye scans the column, and punctuation between fixed columns is noise. 9 fits every shape
# fmt_elapsed produces (`59s` … `100h30m`); anything longer just pushes its own row's model
# right rather than breaking the others.
DUR_WIDTH=9

render_row() {
  local started="$1" count="$2" model="$3"
  local dim="$DIM" off="$OFF"

  local elapsed=$(( now - started ))
  [ "$started" -gt 0 ] || elapsed=0
  [ "$elapsed" -ge 0 ] || elapsed=0

  # Pad BEFORE colouring. Padding a string that already contains escape sequences counts
  # their bytes as width, and every row would be misaligned by exactly the length of a
  # colour code — which is invisible until the colour changes at a threshold.
  local dur; dur=$(printf "%${DUR_WIDTH}s" "$(fmt_elapsed "$elapsed")")

  # Elapsed changes colour at two thresholds. Not decoration: a local endpoint serves one
  # dispatch at a time, so "this one has been holding it for 18 minutes" is the single most
  # actionable thing the line can say, and it should not need reading to notice.
  #
  # Per row now rather than per session, which is the substantive win of splitting them: an
  # 18-minute dispatch goes red on its own row without dragging a 20-second one red too.
  local dur_color="$dim"
  if   [ "$elapsed" -ge 900 ]; then dur_color="$RED"
  elif [ "$elapsed" -ge 300 ]; then dur_color="$YELLOW"
  fi

  # `3×` only when a row stands for more than one dispatch, which now happens only against
  # an older writer whose file carries no per-dispatch lines. On a row that is definitionally
  # one dispatch there is no count worth printing.
  local prefix=""
  [ "$count" -le 1 ] || prefix="${count}× "

  printf '%s %spi%s%s%s%s%s  %s%s%s%s\n' \
    "$DOT" "$dim" "$off" \
    "$dur_color" "$dur" "$off" "" \
    "$dim" "$prefix" "$model" "$off"
}

shown=0
while IFS= read -r row; do
  [ -n "$row" ] || continue
  shown=$(( shown + 1 ))
  if [ "$shown" -gt "$MAX_ROWS" ]; then
    # Never truncate in silence. A capped list that looks complete is a worse lie than one
    # that says how much it is holding back.
    printf '%s  … +%d more%s\n' "$DIM" "$(( ROW_COUNT - MAX_ROWS ))" "$OFF"
    break
  fi
  # `model` is guaranteed space-free by src/status.mjs's sanitize, so splitting the row on
  # whitespace cannot lose part of a name.
  set -- $row
  render_row "$1" "$2" "$3"
done <<EOF
$ROWS
EOF

exit 0
