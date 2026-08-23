# Design notes

Four decisions that cost something to learn, written down so they do not get made again from
scratch: for anyone reading the source, or wondering why a piece of pi-delegate is shaped the way
it is.

## Why review and discuss are slash commands

`/pi-delegate:review` and `/pi-delegate:discuss` are slash commands rather than MCP tools,
deliberately. An MCP tool's schema is paid in every context whether or not it is ever called; a
skill costs nothing until you invoke it. Review and discussion are things you start on purpose,
so they belong on the side of that line that is free when idle.

## Why the completion notification travels over a socket

The socket replaced a `tail -F` over a log file
([issues/1](https://github.com/LarryStanley/pi-delegate/issues/1)): a file gave the writer no
way to observe whether anyone was reading it, so when the reader died the completions simply
stopped and nothing said so. A connection is its own liveness signal, so `pi_dispatch` and
`pi_status` now state outright when no notification is coming, and the monitor reconnects by
itself when `/reload-plugins` restarts the server. The log file is still written — it is what
`pi_result` reads back when a reload empties the in-memory registry.

## Why the status row counts only this window

The rows are **this session's own**, and another Claude Code window's dispatches never appear among
them. 0.13.0 summed across sessions into a single count — every dispatch reaches the same endpoint, so
the machine-wide number looked like the useful one — and that was wrong within the hour: the other
window showed `1 running` for a dispatch its own `pi_result` answers `Unknown session_id` to. A count
you can see and cannot act on, in a window that dispatched nothing, is the shape of
[issues/1](https://github.com/LarryStanley/pi-delegate/issues/1) all over again. 0.13.4 dropped the
aggregate count for one row per running dispatch, and ownership travels on line 2 of the status file
as the writer's raw `CLAUDE_CODE_MESSAGING_SOCKET`, which Claude Code also puts in the status-line
command's environment, so the reader decides ownership with a string comparison — no hashing, no
subprocess on a path that runs every tick.

## Why the status line is bash

The status line is bash rather than Node deliberately. On every tick, a Node process that does
nothing but read one small file measured 40-60ms of interpreter startup against ~100ms for a full
powerline render — a 50% latency increase for one line of text. The status file is written as flat
`key=value` pairs so bash can read it with word splitting and no parser.

The leading dot breathes on a 10-second cycle. Its phase comes from the wall clock rather than
a frame counter, so it looks the same whatever cadence Claude Code happens to rerun the status
line at, and does not freeze mid-animation when the session goes quiet.
