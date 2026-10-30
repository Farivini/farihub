/**
 * macOS-style window controls. The desktop build passes `api` (close, minimize, zoom bound to
 * the native window). In the browser there is no window to control: the dots are shown dimmed,
 * are not focusable and say why.
 */
export interface WindowControlsApi {
  close(): void;
  minimize(): void;
  zoom(): void;
}

export function WindowControls({ api }: { api?: WindowControlsApi | null }) {
  if (!api) {
    return (
      <div className="window-controls unavailable" role="group" aria-label="Controles da janela indisponíveis no navegador"
        title="Fechar, minimizar e ampliar funcionam no aplicativo instalado. No navegador, use as abas e a janela do próprio navegador.">
        <span className="dot close" aria-hidden="true" />
        <span className="dot minimize" aria-hidden="true" />
        <span className="dot zoom" aria-hidden="true" />
      </div>
    );
  }
  return (
    <div className="window-controls" role="group" aria-label="Controles da janela">
      <button className="dot close" aria-label="Fechar janela" onClick={api.close} />
      <button className="dot minimize" aria-label="Minimizar janela" onClick={api.minimize} />
      <button className="dot zoom" aria-label="Ampliar janela" onClick={api.zoom} />
    </div>
  );
}
