/**
 * How a test file's process is spawned: on POSIX in a process group of its own, so that `endGroup` can end the
 * processes its tests leave running. On Windows libuv's job object already ends them with the test file's process.
 */
export function groupOptions(platform: NodeJS.Platform): { detached: boolean; windowsHide: true } {
  return { detached: platform !== 'win32', windowsHide: true };
}

/** A process that detached itself has a group of its own and stays. */
export function endGroup(
  pid: number,
  platform: NodeJS.Platform,
  kill: (pid: number, signal: NodeJS.Signals) => void,
): void {
  if (!groupOptions(platform).detached) {
    return;
  }

  try {
    kill(-pid, 'SIGKILL');
  } catch (error) {
    // The group no longer exists once every process in it has ended.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

/**
 * Waits for a process to end and collects its stderr. Processes it started inherit stderr and can keep it open after
 * it exits; the records of those that end soon arrive by the time stderr closes, so this waits for that, but at most
 * `graceMs` after the exit, and then lets go of stderr. Then it ends what is left of the process's group on `platform`.
 */
export function processEnd(
  child: EndingProcess,
  graceMs: number,
  platform: NodeJS.Platform,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((done, fail) => {
    let errors = '';
    let grace: NodeJS.Timeout | undefined;
    let ended = false;
    const end = (code: number | null) => {
      if (ended) {
        return;
      }

      ended = true;

      try {
        // A process that failed to start has no pid, and no group to end.
        if (child.pid !== undefined) {
          endGroup(child.pid, platform, kill);
        }
      } catch (error) {
        fail(error);

        return;
      }

      done({ exitCode: code, stderr: errors });
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (errors += chunk));
    child.on('error', fail);
    child.on('exit', (code) => {
      grace = setTimeout(() => {
        child.stderr.destroy();
        end(code);
      }, graceMs);
    });
    child.on('close', (code) => {
      clearTimeout(grace);
      end(code);
    });
  });
}

export interface EndingProcess {
  pid?: number;
  stderr: {
    setEncoding(encoding: 'utf8'): unknown;
    on(event: 'data', listener: (chunk: string) => void): unknown;
    destroy(): unknown;
  };
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit' | 'close', listener: (code: number | null) => void): unknown;
}
