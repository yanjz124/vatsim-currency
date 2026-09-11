import { useState } from 'react';
import * as fmt from '../lib/format';
import {
  MAX_SESSION_MS,
  PAGE_SIZE,
  VATSIM_API,
  memberAtcUrl,
  mergeSessions,
  parseSessionsJson,
  saveSessions,
  type Session,
  type SessionSet,
} from '../lib/vatsimApi';

interface Props {
  cid: string;
  since: number;
  sinceLabel: string;
  /** Previously loaded data for this CID, merged with what gets pasted. */
  base: SessionSet | null;
  onImported(set: SessionSet, complete: boolean): void;
  onClose(): void;
}

const TONE = { bad: 'color-fg-danger', warn: 'color-fg-attention' } as const;

export function ManualImport({ cid, since, sinceLabel, base, onImported, onClose }: Props) {
  const [text, setText] = useState('');
  const [pages, setPages] = useState(0);
  const [buffer, setBuffer] = useState<Session[]>([]);
  const [message, setMessage] = useState<{ tone: keyof typeof TONE; text: string } | null>(null);

  const nextUrl = memberAtcUrl(VATSIM_API, cid, PAGE_SIZE, pages * PAGE_SIZE);

  const importText = async (raw: string) => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      setMessage({ tone: 'bad', text: "That isn't valid JSON. Copy the whole page, from the first { to the last }." });
      return;
    }
    const parsed = parseSessionsJson(json);
    if (parsed.cids.length && !parsed.cids.includes(cid)) {
      setMessage({ tone: 'bad', text: `That data belongs to CID ${parsed.cids.join(', ')}, not ${cid}.` });
      return;
    }
    if (!parsed.itemCount && !(json && typeof json === 'object' && 'items' in json)) {
      setMessage({ tone: 'bad', text: 'No sessions found in that text.' });
      return;
    }

    const newBuffer = mergeSessions(buffer, parsed.sessions);
    const reachedEnd = parsed.itemCount < PAGE_SIZE;
    const oldestNew = newBuffer.length ? Math.min(...newBuffer.map((s) => s.start)) : Infinity;

    // Everything from now back to the oldest pasted session is complete. If that
    // reaches back into previously loaded data, the old coverage still holds.
    let coveredSince = reachedEnd ? 0 : oldestNew;
    if (base && !reachedEnd && oldestNew <= base.fetchedAt - MAX_SESSION_MS) {
      coveredSince = Math.min(base.coveredSince, oldestNew);
    }
    const set: SessionSet = {
      cid,
      fetchedAt: Date.now(),
      coveredSince: Number.isFinite(coveredSince) ? coveredSince : since,
      source: 'manual',
      sessions: mergeSessions(base?.sessions ?? [], newBuffer),
    };
    const complete = set.coveredSince <= since - MAX_SESSION_MS;

    setBuffer(newBuffer);
    setPages((p) => p + 1);
    setText('');
    setMessage(
      complete
        ? null
        : {
            tone: 'warn',
            text: `Imported ${parsed.sessions.length} sessions back to ${fmt.day(oldestNew)}. ${sinceLabel} starts ${fmt.day(since)}, so open the next page and paste it too.`,
          },
    );
    await saveSessions(set);
    onImported(set, complete);
  };

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Import sessions for CID {cid}</h2>
        <button className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="panel-body">
        <p className="color-fg-muted mb-2">
          The VATSIM API doesn't let other websites read it, so this page can't download your sessions itself. Your browser can open the
          API directly, and that request comes from your own connection.
        </p>
        <ol className="steps">
          <li>
            Open{' '}
            <a href={nextUrl} target="_blank" rel="noreferrer">
              {pages === 0 ? 'your sessions' : `page ${pages + 1}`}
            </a>{' '}
            <span className="text-mono f6 color-fg-muted">{nextUrl.replace('https://', '')}</span>
          </li>
          <li>Select everything on that page and copy it. In Firefox, switch to the Raw Data tab first.</li>
          <li>Paste it below.</li>
        </ol>
        <textarea
          className="form-control width-full"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text').trim();
            if (pasted.startsWith('{') || pasted.startsWith('[')) {
              e.preventDefault();
              void importText(pasted);
            }
          }}
          placeholder='{"items": [ ... ], "count": ...}'
          rows={4}
          spellCheck={false}
        />
        <div className="hstack mt-2">
          <button className="btn btn-primary" disabled={!text.trim()} onClick={() => void importText(text)}>
            Import
          </button>
          <label className="f6 color-fg-muted text-normal">
            or load a saved .json file{' '}
            <input
              type="file"
              accept=".json,application/json,text/plain"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) await importText(await file.text());
              }}
            />
          </label>
        </div>
        {message && <p className={`${TONE[message.tone]} mt-2 mb-0`}>{message.text}</p>}
      </div>
    </section>
  );
}
