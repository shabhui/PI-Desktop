//! Per-call test barriers, carried onto the real blocking worker like TEST_RG.
use super::*;
use std::cell::RefCell;
use std::sync::{atomic::AtomicUsize, Mutex};
use tokio::sync::oneshot;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Stage {
    Walk,
    Chunk,
    RgRead,
}

pub(crate) struct Probe {
    stage: Stage,
    pub visits: AtomicUsize,
    pub child_pid: AtomicUsize,
    entered: Mutex<Option<oneshot::Sender<()>>>,
    leave: Mutex<std::sync::mpsc::Receiver<()>>,
    finished: Mutex<Option<oneshot::Sender<Option<String>>>>,
}

thread_local! {
    static PROBE: RefCell<Option<Arc<Probe>>> = const { RefCell::new(None) };
}

pub(crate) struct Scope(Option<Arc<Probe>>);

impl Drop for Scope {
    fn drop(&mut self) {
        PROBE.with(|probe| *probe.borrow_mut() = self.0.take());
    }
}

pub(crate) fn current() -> Option<Arc<Probe>> {
    PROBE.with(|probe| probe.borrow().clone())
}

pub(crate) fn install(probe: Option<Arc<Probe>>) -> Scope {
    Scope(PROBE.with(|slot| std::mem::replace(&mut *slot.borrow_mut(), probe)))
}

pub(crate) fn install_rg(path: PathBuf) -> impl Drop {
    super::grep_rg::install_test_rg(path)
}
pub(crate) fn barrier(
    stage: Stage,
) -> (
    Arc<Probe>,
    oneshot::Receiver<()>,
    std::sync::mpsc::Sender<()>,
    oneshot::Receiver<Option<String>>,
) {
    let (entered, entered_rx) = oneshot::channel();
    let (leave_tx, leave) = std::sync::mpsc::channel();
    let (finished, finished_rx) = oneshot::channel();
    (
        Arc::new(Probe {
            stage,
            visits: AtomicUsize::new(0),
            child_pid: AtomicUsize::new(0),
            entered: Mutex::new(Some(entered)),
            leave: Mutex::new(leave),
            finished: Mutex::new(Some(finished)),
        }),
        entered_rx,
        leave_tx,
        finished_rx,
    )
}

pub(super) fn checkpoint(stage: Stage) {
    if let Some(probe) = current().filter(|probe| probe.stage == stage) {
        if probe.visits.fetch_add(1, Ordering::SeqCst) == 1 {
            if let Some(entered) = probe.entered.lock().unwrap().take() {
                let _ = entered.send(());
            }
            // Test panic drops the sender and releases the worker too.
            let _ = probe.leave.lock().unwrap().recv();
        }
    }
}

pub(super) fn child_spawned(pid: u32) {
    if let Some(probe) = current() {
        probe.child_pid.store(pid as usize, Ordering::SeqCst);
    }
}

pub(super) fn completed(result: &Result<Value, hashline::ToolError>) {
    if let Some(probe) = current() {
        if let Some(finished) = probe.finished.lock().unwrap().take() {
            let _ = finished.send(result.as_ref().err().map(|error| error.code.clone()));
        }
    }
}

/// A silent, direct child after one JSON event. The marker only releases a
/// broken implementation during test cleanup; it is not the cancellation path.
pub(crate) struct RgFixture {
    _dir: tempfile::TempDir,
    pub program: PathBuf,
    release: PathBuf,
}

impl RgFixture {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let release = dir.path().join("release");
        #[cfg(windows)]
        let script = format!(
            "@echo off\necho {{\"type\":\"match\",\"data\":{{\"path\":{{\"text\":\"sample.txt\"}},\"line_number\":1,\"lines\":{{\"text\":\"needle\"}}}}}}\n:wait\nif exist \"{}\" exit /b 0\ngoto wait\n",
            release.display()
        );
        #[cfg(not(windows))]
        let script = format!(
            "printf '%s\\n' '{{\"type\":\"match\",\"data\":{{\"path\":{{\"text\":\"sample.txt\"}},\"line_number\":1,\"lines\":{{\"text\":\"needle\"}}}}}}'\nwhile [ ! -f '{}' ]; do :; done\n",
            release.display()
        );
        let program = super::tests::write_fake_rg(dir.path(), &script);
        Self {
            _dir: dir,
            program,
            release,
        }
    }

    pub fn release(&self) {
        std::fs::write(&self.release, "release").unwrap();
    }
}

impl Drop for RgFixture {
    fn drop(&mut self) {
        self.release();
    }
}

pub(crate) fn child_alive(pid: u32) -> bool {
    assert_ne!(pid, 0, "rg must actually spawn");
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code = 0;
            let queried = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            assert_ne!(queried, 0);
            code == 259 // STILL_ACTIVE
        }
    }
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
}
