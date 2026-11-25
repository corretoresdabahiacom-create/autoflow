import { useEffect, useState } from "react";
import { api, errText } from "./api";

const KINDS: Record<string, string> = { access: "Acesso", correction: "Correção", anonymization: "Anonimização/eliminação", portability: "Portabilidade", sharing_info: "Informação sobre compartilhamento", consent_revocation: "Revogação de consentimento" };
const fmt = (d: string) => new Date(d).toLocaleDateString("pt-BR");

/** PRIVACIDADE (KI-092): fila de pedidos de titulares com prazo (15 dias — a confirmar com o jurídico, KI-091). Não digite dados pessoais nas observações. */
export function Privacidade({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<{ tickets: any[]; overdue: number } | null>(null); const [err, setErr] = useState(""); const [kind, setKind] = useState("access"); const [channel, setChannel] = useState("email");
  const load = async () => { try { setData(await api("GET", "/lgpd/tickets?status=open")); setErr(""); } catch (e) { setErr(errText(e)); } };
  useEffect(() => { load(); }, []);
  const open = async (ev: React.FormEvent) => { ev.preventDefault(); try { await api("POST", "/lgpd/tickets", { kind, channel }); load(); } catch (e) { setErr(errText(e)); } };
  const close = async (id: string, outcome: "done" | "rejected") => {
    const resolution = window.prompt(outcome === "done" ? "Como o pedido foi atendido? (sem dados pessoais)" : "Motivo da recusa (sem dados pessoais)"); if (!resolution || resolution.trim().length < 3) return;
    try { await api("POST", `/lgpd/tickets/${id}/close`, { outcome, resolution: resolution.trim() }); load(); } catch (e) { setErr(errText(e)); }
  };
  return (
    <main><div className="row"><button className="secondary" onClick={onBack}>← Voltar</button><h1>Privacidade (LGPD)</h1></div>
      {err && <p className="error" role="alert">{err}</p>}
      <section className="card"><h2>Registrar pedido de titular</h2>
        <form onSubmit={open} className="row">
          <label>Tipo <select value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Canal <select value={channel} onChange={(e) => setChannel(e.target.value)}><option value="email">E-mail</option><option value="phone">Telefone</option><option value="in_person">Presencial</option><option value="portal">Portal</option><option value="other">Outro</option></select></label>
          <button type="submit">Registrar (prazo de 15 dias)</button></form></section>
      <section className="card"><h2>Pedidos em aberto{data && data.overdue > 0 ? ` — ${data.overdue} atrasado(s)` : ""}</h2>
        {!data ? <p className="muted">Carregando…</p> : data.tickets.length === 0 ? <p className="muted">Nenhum pedido em aberto.</p> :
          <table><thead><tr><th scope="col">Tipo</th><th scope="col">Recebido</th><th scope="col">Prazo</th><th scope="col">Situação</th><th scope="col">Ações</th></tr></thead>
            <tbody>{data.tickets.map((t) => <tr key={t.id}><td>{KINDS[t.kind]}</td><td>{fmt(t.received_at)}</td><td>{fmt(t.due_at)}</td>
              <td>{t.overdue ? <strong className="error">Atrasado</strong> : `${t.days_left} dia(s)`}</td>
              <td><button className="secondary" onClick={() => close(t.id, "done")}>Atendido</button> <button className="secondary" onClick={() => close(t.id, "rejected")}>Recusar</button></td></tr>)}</tbody></table>}
        <p className="muted">Exportação e anonimização de um cliente específico: ficha do cliente (API <code>/customers/:id/export</code> e <code>/anonymize</code>).</p></section>
    </main>
  );
}
