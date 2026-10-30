import { useState } from 'react';
import { FILE_EXTENSION } from '../../core/file-format.ts';
import type { Loss, SaveFormat } from '../../core/save-plan.ts';
import type { SinkMode } from '../files.ts';
import { Dialog } from '../shell/Dialog.tsx';

const EXTENSIONS: Record<SaveFormat, string> = { xlsx: '.xlsx', farcel: FILE_EXTENSION };

/**
 * Save as (format and name), or, for Ctrl+S on an .xlsx that would lose something, the losses
 * with the choice to save anyway or keep everything in a .farcel. In a browser without file
 * access the action is named for what happens: a copy is downloaded.
 */
export function SaveDialog({ start, name, format, lossesFor, sinkMode, onCancel, onSave }: {
  start: 'choose' | 'confirm';
  name: string;
  format: SaveFormat;
  lossesFor(format: SaveFormat): Loss[];
  sinkMode: SinkMode;
  onCancel(): void;
  /** `choose`: a new file (Save as); otherwise the current file. */
  onSave(format: SaveFormat, name: string, choose: boolean): void;
}) {
  const [step, setStep] = useState(start);
  const [chosen, setChosen] = useState(format);
  const [base, setBase] = useState(name);
  const losses = lossesFor(chosen);
  const download = sinkMode === 'download';
  const fileName = `${base.trim() || 'Pasta1'}${EXTENSIONS[chosen]}`;

  if (step === 'confirm') {
    return (
      <Dialog title="Salvar em XLSX com perdas?" testId="save-confirm" onClose={onCancel} actions={<>
        <button type="button" onClick={onCancel}>Cancelar</button>
        <button type="button" data-testid="save-as-farcel" onClick={() => { setChosen('farcel'); setStep('choose'); }}>Salvar como .farcel…</button>
        <button type="button" className="primary" data-testid="save-anyway" onClick={() => onSave('xlsx', base, false)}>
          {download ? 'Baixar XLSX assim mesmo' : 'Salvar XLSX assim mesmo'}
        </button>
      </>}>
        <p>O arquivo {fileName} não terá:</p>
        <ul className="report-list" data-testid="save-losses">{losses.map(loss => <li key={loss.text}>{loss.text}</li>)}</ul>
        <p>O .farcel guarda tudo o que o Planilhas tem; o XLSX abre no Excel e em outros programas.</p>
        {download && <DownloadNote />}
      </Dialog>
    );
  }

  return (
    <Dialog title="Salvar como" testId="save-as" onClose={onCancel} actions={<>
      <button type="button" onClick={onCancel}>Cancelar</button>
      <button type="button" className="primary" data-testid="save-as-confirm" onClick={() => onSave(chosen, base, true)}>
        {download ? 'Baixar cópia' : 'Salvar'}
      </button>
    </>}>
      <label>Nome
        <input value={base} data-testid="save-name" onChange={e => setBase(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') onSave(chosen, base, true); }} />
      </label>
      <fieldset className="format-choice" data-testid="save-format">
        <label className={chosen === 'xlsx' ? 'option on' : 'option'}>
          <input type="radio" name="format" value="xlsx" checked={chosen === 'xlsx'} onChange={() => setChosen('xlsx')} />
          <span><strong>Excel (.xlsx)</strong> — padrão; abre no Excel, LibreOffice e Google Planilhas.</span>
        </label>
        <label className={chosen === 'farcel' ? 'option on' : 'option'}>
          <input type="radio" name="format" value="farcel" checked={chosen === 'farcel'} onChange={() => setChosen('farcel')} />
          <span><strong>Pasta Fariv (.farcel)</strong> — formato nativo; guarda também dinâmicas, gráficos e as ressalvas de importação.</span>
        </label>
      </fieldset>
      {losses.length > 0 && <>
        <p>O arquivo {fileName} não terá:</p>
        <ul className="report-list" data-testid="save-losses">{losses.map(loss => <li key={loss.text}>{loss.text}</li>)}</ul>
      </>}
      {download && <DownloadNote />}
    </Dialog>
  );
}

function DownloadNote() {
  return (
    <p className="download-note" data-testid="download-note">
      Este navegador não grava direto em arquivos: será baixada uma <strong>cópia</strong> para a pasta de downloads. O arquivo que você abriu não é alterado; para continuar depois, abra a cópia baixada.
    </p>
  );
}
