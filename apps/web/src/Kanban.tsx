import { useCallback, useEffect, useRef, useState } from "react";
import { api, errText } from "./api";

interface Card { id: string; number: number; plate: string; tasksOpen: number; tasksDone: number }
interface Col { id: string; name: string; orders: Card[] }

/** Kanban: arrastar com mouse/toque OU teclado (foco no cartão + ←/→) OU seletor "Mover para" (mobile). */
export function Kanban({ onOpen, onBack }: { onOpen: (id: string) => void; onBack: () => void }) {
  const [cols, setCols] = useState<Col[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const focusId = useRef<string | null>(null);

  const load = useCallback(async () => {
    try { setCols((await api("GET", "/production/board")).columns); setErr(null); } catch (e) { setErr(errText(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (focusId.current) document.getElementById(`card-${focusId.current}`)?.focus(); });

  const move = async (card: Card, to: Col) => {
    focusId.current = card.id;
    try { await api("PUT", `/orders/${card.id}/stage`, { stageId: to.id }); setLive(`OS ${card.number} movida para ${to.name}`); await load(); }
    catch (e) { setErr(errText(e)); }
  };

  if (!cols) return <main><button className="secondary" onClick={onBack}>← Voltar</button>{err ? <p className="error" role="alert">{err}</p> : <p role="status" className="muted">Carregando…</p>}</main>;
  return (
    <main className="board-wrap">
      <div className="row"><button className="secondary" onClick={onBack}>← Voltar</button><h1>Produção</h1></div>
      {err && <p className="error" role="alert">{err}</p>}
      <p className="muted">Arraste um cartão, ou use ← → com o cartão focado, ou o seletor “Mover para”.</p>
      <div aria-live="polite" className="sr-only">{live}</div>
      <div className="board">
        {cols.map((col, ci) => (
          <section key={col.id} className="column" aria-label={col.name}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { const id = e.dataTransfer.getData("text/plain"); const card = cols.flatMap((c) => c.orders).find((o) => o.id === id); if (card) move(card, col); }}>
            <h2>{col.name} <span className="muted">({col.orders.length})</span></h2>
            {col.orders.length === 0 && <p className="muted">Vazio</p>}
            {col.orders.map((o) => (
              <article key={o.id} id={`card-${o.id}`} className="kcard" tabIndex={0} draggable
                aria-label={`OS ${o.number}, placa ${o.plate}, etapa ${col.name}`}
                onDragStart={(e) => e.dataTransfer.setData("text/plain", o.id)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" && cols[ci + 1]) { e.preventDefault(); move(o, cols[ci + 1]!); }
                  if (e.key === "ArrowLeft" && cols[ci - 1]) { e.preventDefault(); move(o, cols[ci - 1]!); }
                  if (e.key === "Enter") onOpen(o.id);
                }}>
                <strong>OS {o.number}</strong> · {o.plate}
                <div className="muted">{o.tasksOpen} abertas · {o.tasksDone} concluídas</div>
                <label>Mover para
                  <select value={col.id} onChange={(e) => { const to = cols.find((c) => c.id === e.target.value); if (to && to.id !== col.id) move(o, to); }}>
                    {cols.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
              </article>))}
          </section>))}
      </div>
    </main>
  );
}
