export function createRegistry() {
  const sessions = new Map();

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
    },
    get,
    has: (sessionId) => sessions.has(sessionId),
    update(sessionId, patch) {
      const next = { ...get(sessionId), ...patch };
      sessions.set(sessionId, next);
      return next;
    },
    ids: () => [...sessions.keys()],
  };
}
