// onChange fires after any mutation, and is where the status line's data comes from.
//
// It is called inside a try/catch and its return value is ignored on purpose. Whatever it
// does is downstream of the dispatch, never part of it — the same rule appendEventsLog
// learned the hard way in issues/1, where a failure to *announce* a result was allowed to
// destroy the result. A registry mutation must succeed or fail on its own terms.
export function createRegistry({ onChange = null } = {}) {
  const sessions = new Map();

  function changed() {
    if (!onChange) return;
    try {
      onChange([...sessions.values()]);
    } catch {
      // deliberately swallowed — see above
    }
  }

  function get(sessionId) {
    if (!sessions.has(sessionId)) {
      const known = [...sessions.keys()];
      throw new Error(
        `Unknown session_id "${sessionId}". Currently valid: ${known.length ? known.join(", ") : "(none)"}`,
      );
    }
    return sessions.get(sessionId);
  }

  return {
    add(sessionId, entry) {
      if (sessions.has(sessionId)) throw new Error(`session_id "${sessionId}" already exists`);
      sessions.set(sessionId, { ...entry });
      changed();
    },
    get,
    has: (sessionId) => sessions.has(sessionId),
    update(sessionId, patch) {
      const next = { ...get(sessionId), ...patch };
      sessions.set(sessionId, next);
      changed();
      return next;
    },
    ids: () => [...sessions.keys()],
  };
}
