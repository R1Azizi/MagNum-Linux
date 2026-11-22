// Linux reparents orphaned descendants to the nearest subreaper, including
// processes which create a new session or redirect all of their stdio.
use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::raw::{c_int, c_short, c_ulong};
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, Stdio};

#[repr(C)]
struct PollFd {
    fd: c_int,
    events: c_short,
    revents: c_short,
}

extern "C" {
    fn prctl(option: c_int, ...) -> c_int;
    fn poll(fds: *mut PollFd, count: c_ulong, timeout: c_int) -> c_int;
    fn kill(pid: c_int, signal: c_int) -> c_int;
    fn waitpid(pid: c_int, status: *mut c_int, options: c_int) -> c_int;
}

const CHILDREN: &str = "/proc/thread-self/children";

fn reap_descendants() -> io::Result<()> {
    loop {
        let children = fs::read_to_string(CHILDREN)?;
        if children.trim().is_empty() {
            return Ok(());
        }
        for entry in children.split_whitespace() {
            let pid = entry.parse::<c_int>().map_err(io::Error::other)?;
            // This single-threaded supervisor alone can reap these direct
            // children, so each PID remains reserved through its waitpid.
            if unsafe { kill(pid, 9) } < 0 {
                return Err(io::Error::last_os_error());
            }
            while unsafe { waitpid(pid, std::ptr::null_mut(), 0) } < 0 {
                let err = io::Error::last_os_error();
                if err.kind() != io::ErrorKind::Interrupted {
                    return Err(err);
                }
            }
        }
    }
}

fn run(shell: OsString, command: OsString) -> io::Result<i32> {
    const PR_SET_CHILD_SUBREAPER: c_int = 36;
    if unsafe {
        prctl(
            PR_SET_CHILD_SUBREAPER,
            1 as c_ulong,
            0 as c_ulong,
            0 as c_ulong,
            0 as c_ulong,
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    fs::read_to_string(CHILDREN)?;
    let mut child = Command::new(shell)
        .arg("-c")
        .arg(command)
        .stdin(Stdio::null())
        .spawn()?;
    let mut control = PollFd {
        fd: 0,
        events: 1,
        revents: 0,
    };
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        // The parent closes stdin to cancel. Parent death also closes it.
        let ready = unsafe { poll(&mut control, 1, 25) };
        if ready < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        if ready != 0 {
            child.kill()?;
            break child.wait()?;
        }
    };
    reap_descendants()?;
    Ok(status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(1)))
}

fn main() {
    let mut args = std::env::args_os().skip(1);
    let (Some(shell), Some(command)) = (args.next(), args.next()) else {
        std::process::exit(2)
    };
    let code = run(shell, command).unwrap_or_else(|err| {
        eprintln!("Command supervisor failed: {err}");
        1
    });
    std::process::exit(code);
}
