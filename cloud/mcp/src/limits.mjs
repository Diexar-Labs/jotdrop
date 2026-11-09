// A brake for an agent that runs in a loop, or a prompt injection that wants to write a lot: per process at most
// 60 tool calls and 20 changes in any minute. A refused call does nothing and does not count.
export const CALLS_PER_MINUTE = 60;
export const WRITES_PER_MINUTE = 20;

export function createLimiter({ calls = CALLS_PER_MINUTE, writes = WRITES_PER_MINUTE, windowMs = 60_000, now = Date.now } = {}) {
  const callTimes = [], writeTimes = [];
  const drop = (times, from) => { while (times.length && times[0] <= from) times.shift(); };
  return {
    /** null when the call may go ahead (and is counted), otherwise the answer for the agent. */
    take(write) {
      const at = now();
      drop(callTimes, at - windowMs);
      drop(writeTimes, at - windowMs);
      if (callTimes.length >= calls || (write && writeTimes.length >= writes)) {
        return `Too many requests: slow down. JotDrop allows ${calls} tool calls and ${writes} changes per minute. Nothing was done; try again in a minute.`;
      }
      callTimes.push(at);
      if (write) writeTimes.push(at);
      return null;
    },
  };
}
