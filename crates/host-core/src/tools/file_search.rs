//! Cooperative cancellation for read-only filesystem work. The caller keeps
//! its execution lease until all synchronous work and owned-child cleanup end.
use super::{hashline, HashlineContext};
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use tokio::sync::watch;

pub(super) type Cancellation = Option<watch::Receiver<bool>>;
pub(super) const CHUNK_BYTES: usize = 64 * 1024;

pub(super) fn aborted() -> (String, String) {
    ("TOOL_ABORTED".into(), "tool aborted".into())
}

pub(super) fn check(cancellation: &Cancellation) -> Result<(), (String, String)> {
    if cancellation.as_ref().is_some_and(|rx| *rx.borrow()) {
        Err(aborted())
    } else {
        Ok(())
    }
}

pub(super) fn check_io(cancellation: &Cancellation) -> io::Result<()> {
    check(cancellation).map_err(|(_, message)| io::Error::new(io::ErrorKind::Interrupted, message))
}

pub(super) async fn cancelled(cancellation: &mut Cancellation) {
    let Some(rx) = cancellation.as_mut() else {
        return std::future::pending().await;
    };
    loop {
        if *rx.borrow() {
            return;
        }
        if rx.changed().await.is_err() {
            // Registry removal without true is not an abort.
            return std::future::pending().await;
        }
    }
}

pub(super) fn read_file(path: &Path, cancellation: &Cancellation) -> io::Result<Vec<u8>> {
    check_io(cancellation)?;
    read_chunks(&mut File::open(path)?, cancellation)
}

fn read_chunks(reader: &mut impl Read, cancellation: &Cancellation) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = [0; CHUNK_BYTES];
    loop {
        check_io(cancellation)?;
        match reader.read(&mut chunk) {
            Ok(0) => return Ok(bytes),
            Ok(n) => bytes.extend_from_slice(&chunk[..n]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

/// Keep tag normalization and seen-line semantics, but do not reintroduce an
/// uncancellable whole-file read after the search itself has stopped scanning.
pub(super) fn record_grep_file(
    ctx: Option<&HashlineContext<'_>>,
    path: &Path,
    display: &str,
    matched_lines: Option<&[u64]>,
    cancellation: &Cancellation,
) -> Result<Option<(String, String)>, (String, String)> {
    let bytes = read_file(path, cancellation);
    check(cancellation)?;
    let Ok(bytes) = bytes else { return Ok(None) };
    if hashline::looks_binary_bytes(&bytes) {
        return Ok(None);
    }
    let file = hashline::normalize_file(&bytes);
    check(cancellation)?;
    let tag = hashline::tag_of_lf_text(&file.text);
    check(cancellation)?;
    if let Some(ctx) = ctx {
        ctx.store.record(
            ctx.session_id,
            &hashline::canonical_key(path),
            &file,
            &tag,
            Some(
                matched_lines
                    .unwrap_or_default()
                    .iter()
                    .map(|n| *n as u32)
                    .collect(),
            ),
        );
    }
    Ok(Some((display.to_string(), tag)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::{poll_fn, Future};
    use std::task::Poll;

    #[tokio::test]
    async fn closed_false_sender_is_not_cancellation_but_closed_true_is() {
        let (tx, rx) = watch::channel(false);
        drop(tx);
        let mut signal = Some(rx);
        assert!(check(&signal).is_ok());
        let mut wait = Box::pin(cancelled(&mut signal));
        poll_fn(|cx| {
            assert!(wait.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        let (tx, rx) = watch::channel(false);
        tx.send(true).unwrap();
        drop(tx);
        let mut signal = Some(rx);
        assert_eq!(check(&signal), Err(aborted()));
        cancelled(&mut signal).await;
    }

    #[test]
    fn content_read_stops_before_another_bounded_chunk() {
        struct Reader {
            tx: watch::Sender<bool>,
            calls: usize,
        }
        impl Read for Reader {
            fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
                self.calls += 1;
                assert_eq!(bytes.len(), CHUNK_BYTES);
                bytes.fill(b'x');
                self.tx.send(true).unwrap();
                Ok(bytes.len())
            }
        }
        let (tx, rx) = watch::channel(false);
        let mut reader = Reader { tx, calls: 0 };
        let error = read_chunks(&mut reader, &Some(rx)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        assert_eq!(reader.calls, 1, "no read after cancellation");
    }

    #[test]
    fn cancellable_tags_preserve_the_hashline_contract() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.txt");
        for bytes in [
            b"needle\r\nnext\r\n".as_slice(),
            b"\xef\xbb\xbfneedle\n",
            b"",
            b"\0binary",
        ] {
            std::fs::write(&path, bytes).unwrap();
            assert_eq!(
                record_grep_file(None, &path, "sample.txt", Some(&[1]), &None).unwrap(),
                hashline::record_grep_file(None, &path, "sample.txt", Some(&[1])),
            );
        }
    }
}
