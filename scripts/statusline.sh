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

running=0
oldest=0
models=""

if [ -d "$STATUS_DIR" ]; then
  for f in "$STATUS_DIR"/*.status; do
    # An unmatched glob comes through as the literal pattern.
    [ -f "$f" ] || continue

    pid=""; r=0; o=0; m=""; file_owner=""
    { read -r line; read -r file_owner; } < "$f" || true
    [ -n "${line:-}" ] || continue

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
    kill -0 "$pid" 2>/dev/null || continue

    [ "$r" -gt 0 ] || continue

    running=$(( running + r ))
    if [ "$o" -gt 0 ] && { [ "$oldest" -eq 0 ] || [ "$o" -lt "$oldest" ]; }; then
      oldest="$o"
    fi
    [ "$m" = "-" ] || models="${models},${m}"
  done
fi

# Nothing running: no line, no blank row, no trace.
[ "$running" -gt 0 ] || exit 0

# Two concurrent dispatches on the same model should not print it twice.
dedup=""
_ifs="$IFS"; IFS=','
for m in $models; do
  [ -n "$m" ] || continue
  case ",$dedup," in *",$m,"*) continue ;; esac
  dedup="${dedup:+$dedup,}$m"
done
IFS="$_ifs"
models="$dedup"

# PI_DELEGATE_NOW pins the clock. It exists so the breathing animation can be tested
# deterministically, and so you can preview any moment while editing `render` below:
#
#   PI_DELEGATE_NOW=$(( $(date +%s) + 5 )) ./statusline.sh
#
now="${PI_DELEGATE_NOW:-$(date +%s)}"
case "$now" in ''|*[!0-9]*) now=$(date +%s) ;; esac
elapsed=$(( now - oldest ))
[ "$oldest" -gt 0 ] || elapsed=0
[ "$elapsed" -ge 0 ] || elapsed=0

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

color_mode() {
  case "$COLORTERM" in
    truecolor|24bit) printf 'truecolor' ;;
    *)               printf 'basic' ;;
  esac
}

# ---------------------------------------------------------------- render
#
# THIS IS THE PART YOU CHANGE. Everything it can use:
#
#   $running   dispatches in flight in THIS session (never another window's)
#   $elapsed   seconds since the oldest one started
#   $models    comma-separated, deduplicated, provider prefix already stripped
#
# Keep it to one line and keep it short — the status bar has a width budget and the rest
# of it belongs to whatever was already there.

render() {
  local esc=$'\033'
  local dim="${esc}[2m" off="${esc}[0m"
  local dot; dot=$(breathing_dot "$(color_mode)")
  local dur; dur=$(fmt_elapsed "$elapsed")

  # Elapsed changes colour at two thresholds. Not decoration: a local endpoint serves one
  # dispatch at a time, so "someone has been holding it for 18 minutes" is the single most
  # actionable thing this line can tell you, and it should not need reading to notice.
  local dur_color="$dim"
  if   [ "$elapsed" -ge 900 ]; then dur_color="${esc}[31m"
  elif [ "$elapsed" -ge 300 ]; then dur_color="${esc}[33m"
  fi

  printf '%s %spi ⇢%s %d running %s·%s %s%s%s %s·%s %s%s%s\n' \
    "$dot" "$dim" "$off" "$running" \
    "$dim" "$off" "$dur_color" "$dur" "$off" \
    "$dim" "$off" "$dim" "$models" "$off"
}

render
exit 0
