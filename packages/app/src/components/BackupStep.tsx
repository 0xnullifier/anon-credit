// Step 5: backup and restore. The backup string ("acb1.") has the batch secrets and session
// keys of this browser. Restore writes the batches into the encrypted store of another browser.

import { BACKUP_PREFIX, decodeBackup, importBackup } from "@anon-credit/sdk";
import { useState } from "react";
import { explainLine } from "../lib/explain.ts";
import type { Workbench } from "../lib/workbench.ts";
import { Section } from "./primitives.tsx";

export function BackupStep({
  workbench,
  passphrase,
  onRestored,
}: {
  readonly workbench: Workbench | null;
  readonly passphrase: string;
  readonly onRestored: () => void;
}) {
  const [backup, setBackup] = useState("");
  const [exportInfo, setExportInfo] = useState("");
  const [restoreText, setRestoreText] = useState("");
  const [restoreInfo, setRestoreInfo] = useState("");
  const [restoreBad, setRestoreBad] = useState(false);

  if (workbench === null) {
    return (
      <Section n={5} title="backup and restore" state="locked">
        <p className="note">Needs an unlocked store.</p>
      </Section>
    );
  }

  const doExport = async (): Promise<void> => {
    try {
      const text = await workbench.client.exportBackup();
      const decoded = decodeBackup(text);
      setBackup(text);
      setExportInfo(`${decoded.batches.length} batch record(s), ${text.length} characters, format ${decoded.format}. The string has secrets: keep it like the passphrase.`);
    } catch (error) {
      setBackup("");
      setExportInfo(explainLine(error));
    }
  };

  const doRestore = async (): Promise<void> => {
    setRestoreBad(false);
    try {
      const added = await importBackup(workbench.storage, passphrase, restoreText.trim());
      setRestoreInfo(`${added} batch record(s) added to this store. Batches that were already here are unchanged.`);
      onRestored();
    } catch (error) {
      setRestoreBad(true);
      setRestoreInfo(explainLine(error));
    }
  };

  return (
    <Section n={5} title="backup and restore" state="idle">
      <p className="note">
        One string moves a batch between browsers: deployment identity, batch secrets, session keys, leaf metadata, open request, session
        state. It starts with <code>{BACKUP_PREFIX}</code> and ends with a keccak checksum. Paths are fetched again after a restore.
      </p>
      <div className="row">
        <button type="button" onClick={doExport}>
          export backup
        </button>
        <span className="note">{exportInfo}</span>
      </div>
      {backup === "" ? null : <textarea readOnly rows={4} value={backup} onFocus={(event) => event.target.select()} spellCheck={false} />}
      <div className="row">
        <label>
          restore from a backup string
          <textarea rows={3} value={restoreText} onChange={(event) => setRestoreText(event.target.value)} placeholder={`${BACKUP_PREFIX}…`} spellCheck={false} />
        </label>
        <span className="actions">
          <button type="button" onClick={doRestore} disabled={!restoreText.trim().startsWith(BACKUP_PREFIX)}>
            restore
          </button>
        </span>
      </div>
      {restoreInfo === "" ? null : <p className={`note ${restoreBad ? "bad" : ""}`}>{restoreInfo}</p>}
    </Section>
  );
}
