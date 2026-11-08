/**
 * Per-tool lock: scans take a shared hold while they run a tool; install/update/remove take an
 * exclusive hold, so a tool is never swapped while a scan is using it. Once an exclusive hold is
 * waiting, new scans wait behind it.
 */
export function createToolLock() {
  const readers = new Map();
  const exclusive = new Map();
  const idleWaiters = new Map();

  const notifyIdle = (id) => {
    if ((readers.get(id) || 0) > 0) return;
    (idleWaiters.get(id) || []).forEach((fn) => fn());
    idleWaiters.delete(id);
  };

  async function shared(id) {
    while (exclusive.get(id)) await exclusive.get(id);
    readers.set(id, (readers.get(id) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      readers.set(id, readers.get(id) - 1);
      notifyIdle(id);
    };
  }

  async function withExclusive(id, fn, timeoutMs = 30 * 60 * 1000) {
    while (exclusive.get(id)) await exclusive.get(id).catch(() => {});
    let done;
    const gate = new Promise((r) => { done = r; });
    exclusive.set(id, gate);
    try {
      if ((readers.get(id) || 0) > 0) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('มีการสแกนที่ใช้ scanner นี้อยู่นานเกิน 30 นาที ยกเลิกการเปลี่ยนเวอร์ชัน')), timeoutMs);
          const list = idleWaiters.get(id) || [];
          list.push(() => { clearTimeout(t); resolve(); });
          idleWaiters.set(id, list);
        });
      }
      return await fn();
    } finally {
      exclusive.delete(id);
      done();
    }
  }

  return { shared, withExclusive, inUse: (id) => (readers.get(id) || 0) > 0 };
}
