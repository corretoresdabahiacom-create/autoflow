import { useCallback, useEffect, useState } from "react";
import { api, errText } from "./api";

const STATUS: [string, string][] = [["new", "Novo"], ["contacted", "Contatado"], ["quoted", "Orçado"], ["scheduled", "Agendado"], ["won", "Ganho"], ["lost", "Perdido"]];

/** PRESENÇA DIGITAL (UI mínima, KI-047): links públicos, publicar rascunho (JSON) e funil de leads. */
export function Presenca({ onBack }: { onBack: () => void }) {
  const [site, setSite] = useState<any>(null);
  const [leads, setLeads] = useState<any>(null);
  const [json, setJson] = useState(""); const [tpl, setTpl] = useState("moderno");
  const [err, setErr] = useState(""); const [msg, setMsg] = useState("");
  const load = useCallback(async () => {
    try {
      const s = await api("GET", "/site"); setSite(s);
      setTpl(s.draft?.template ?? s.published?.template ?? "moderno");
      setJson((j) => j || JSON.stringify((s.draft ?? s.published)?.config ?? s.defaults, null, 2));
      setLeads(await api("GET", "/leads").catch(() => null)); setErr("");
    } catch (e) { setErr(errText(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, ok: string) => { setErr(""); setMsg(""); try { await fn(); setMsg(ok); await load(); } catch (e) { setErr(errText(e)); } };
  const move = (id: string, status: string) => run(() => api("PATCH", `/leads/${id}/status`, { status, ...(status === "lost" ? { lostReason: prompt("Motivo da perda:") ?? "" } : {}) }), "Lead atualizado.");

  if (!site) return <main><button className="secondary" onClick={onBack}>← Voltar</button>{err ? <p className="error" role="alert">{err}</p> : <p role="status" className="muted">Carregando…</p>}</main>;
  return (
    <main>
      <div className="row"><button className="secondary" onClick={onBack}>← Voltar</button><h1>Presença digital</h1></div>
      {err && <p className="error" role="alert">{err}</p>}{msg && <p role="status">{msg}</p>}
      <section className="card"><h2>Links públicos</h2>
        <p>Site: <a href={site.publicUrl} target="_blank" rel="noopener">{site.publicUrl}</a> {site.published ? "" : <span className="muted">(ainda não publicado)</span>}</p>
        <p>Cartão: <a href={site.cardUrl} target="_blank" rel="noopener">{site.cardUrl}</a></p></section>
      <section className="card"><h2>Conteúdo do site</h2>
        <label>Modelo<select value={tpl} onChange={(e) => setTpl(e.target.value)}>{site.templates.map((t: string) => <option key={t} value={t}>{t}</option>)}</select></label>
        <label>Configuração (JSON)<textarea rows={14} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} /></label>
        <div className="row">
          <button onClick={() => run(() => api("PUT", "/site/draft", { template: tpl, config: JSON.parse(json) }), "Rascunho salvo.")}>Salvar rascunho</button>
          <button className="secondary" disabled={!site.draft} onClick={() => run(() => api("POST", "/site/publish"), "Publicado.")}>Publicar rascunho</button></div></section>
      {leads && <section><h2>Pedidos de orçamento</h2>
        <p className="muted">{STATUS.map(([k, l]) => `${l}: ${leads.counts[k] ?? 0}`).join(" · ")}</p>
        {leads.leads.length === 0 && <p className="muted">Nenhum lead ainda.</p>}
        <ul className="list">{leads.leads.map((l: any) => (
          <li key={l.id}><div className="row"><span>{l.name} · {l.vehicle} · {l.service}{l.campaign ? ` · #${l.campaign}` : ""}</span>
            <select aria-label={`Status de ${l.name}`} value={l.status} onChange={(e) => move(l.id, e.target.value)}>{STATUS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div></li>))}</ul></section>}
    </main>
  );
}
