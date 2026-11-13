#!/usr/bin/env python3
"""Run a login shell on a real PTY for the monitor's Console page.

argv:  pty-helper.py SHELL COLS ROWS
fd 0:  keystrokes from the browser  -> PTY
fd 1:  PTY output                   -> browser
fd 3:  control lines "COLS ROWS\n"  -> window resize
Exit code is the shell's exit code.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def main():
    shell = sys.argv[1]
    cols, rows = int(sys.argv[2]), int(sys.argv[3])
    pid, master = pty.fork()
    if pid == 0:
        try:
            os.chdir(os.environ.get('HOME') or '/')
        except OSError:
            pass
        os.execvp(shell, ['-' + os.path.basename(shell)])  # leading "-" => login shell
    set_size(master, cols, rows)

    ctl = ''
    inputs = [0, master]
    try:
        os.fstat(3)
        inputs.append(3)
    except OSError:
        pass

    code = 0
    try:
        while True:
            ready, _, _ = select.select(inputs, [], [])
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b''
                if not data:
                    break
                os.write(1, data)
            if 0 in ready:
                data = os.read(0, 65536)
                if not data:  # browser went away
                    break
                while data:
                    n = os.write(master, data)
                    data = data[n:]
            if 3 in ready:
                data = os.read(3, 256)
                if not data:
                    inputs.remove(3)
                else:
                    ctl += data.decode('ascii', 'ignore')
                    while '\n' in ctl:
                        line, ctl = ctl.split('\n', 1)
                        try:
                            c, r = line.split()
                            set_size(master, int(c), int(r))
                        except (ValueError, OSError):
                            pass
    finally:
        try:
            os.kill(pid, signal.SIGHUP)
        except OSError:
            pass
        try:
            _, status = os.waitpid(pid, 0)
            code = os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else (status >> 8)
        except OSError:
            pass
    sys.exit(code if code >= 0 else 1)


if __name__ == '__main__':
    main()
