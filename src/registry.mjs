export function createRegistry() {
  const sessions = new Map();

  function get(sessionId) {
    if (!sessions.has(sessionId)) {
      const known = [...sessions.keys()];
      throw new Error(
        `未知的 session_id "${sessionId}"。目前有效的：${known.length ? known.join(", ") : "(無)"}`,
      );
    }
    return sessions.get(sessionId);
  }

  return {
    add(sessionId, entry) {
      if (sessions.has(sessionId)) throw new Error(`session_id "${sessionId}" 已存在`);
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
