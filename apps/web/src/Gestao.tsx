import { useEffect, useState } from "react";
import { api, errText } from "./api";

const money = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dt = (d?: string | null) => (d ? new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");
const CLAIM_STATUS: Record<string, string> = { opened: "Aberto", awaiting_authorization: "Aguardando autorização", authorized: "Autorizado", partially_authorized: "Autorizado em parte", denied: "Negado", completed: "Concluído", paid: "Pago", cancelled: "Cancelado" };
const DEADLINE: Record<string, string> = { overdue: "Vencido", due_soon: "Vence em breve", ok: "No prazo", none: "—" };
const toCents = (s: string) => Math.round(Number(s.replace(/\./g, "").replace(",", ".")) * 100);
const ask = (msg: string) => { const v = window.prompt(msg); return v && v.trim() ? v.trim() : null; };

type Tab = "sinistros" | "comissoes" | "agenda" | "transferencias";
const TABS: [Tab, string][] = [["sinistros", "Sinistros"], ["comissoes", "Comissões"], ["agenda", "Agenda e espera"], ["transferencias", "Transferências"]];

/** GESTÃO (KI-085b): telas de operação dos recursos Premium. O backend nega sem o plano (mostramos o erro). */
export function Gestao() {
  const [tab, setTab] = useState<Tab>("sinistros");
  return (
    <section className="card"><h2>Gestão</h2>
      <div className="row" role="tablist" aria-label="Áreas de gestão">
        {TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "" : "secondary"} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {tab === "sinistros" && <Sinistros />}{tab === "comissoes" && <Comissoes />}{tab === "agenda" && <Agenda />}{tab === "transferencias" && <Transferencias />}
    </section>
  );
}

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null); const [err, setErr] = useState("");
  const load = async () => { try { setData(await api("GET", path)); setErr(""); } catch (e) { setErr(errText(e)); } };
  useEffect(() => { load(); }, [path]);
  return { data, err, setErr, load };
}

function Sinistros() {
  const claims = useLoad<{ claims: any[] }>("/claims"); const ins = useLoad<{ insurers: any[] }>("/insurers");
  const [form, setForm] = useState({ osId: "", insurerId: "", claimNo: "", deductible: "0", requested: "0" }); const [insName, setInsName] = useState(""); const [msg, setMsg] = useState("");
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); setMsg(ok); claims.load(); ins.load(); } catch (e) { setMsg(errText(e)); } };
  const insName_ = (id: string) => ins.data?.insurers.find((i) => i.id === id)?.name ?? "—";
  return (<div>
    {(claims.err || msg) && <p className="error" role="alert">{claims.err || msg}</p>}
    <h3>Seguradoras</h3>
    <form className="row" onSubmit={(e) => { e.preventDefault(); run(() => api("POST", "/insurers", { name: insName }), "Seguradora cadastrada."); setInsName(""); }}>
      <label>Nome <input value={insName} onChange={(e) => setInsName(e.target.value)} required minLength={2} /></label><button type="submit">Cadastrar seguradora</button></form>
    <h3>Abrir sinistro</h3>
    <form className="row" onSubmit={(e) => { e.preventDefault(); run(() => api("POST", `/orders/${form.osId.trim()}/claims`, { insurerId: form.insurerId, claimNo: form.claimNo, deductibleCents: toCents(form.deductible), requestedCents: toCents(form.requested) }), "Sinistro aberto."); }}>
      <label>ID da OS <input value={form.osId} onChange={(e) => setForm({ ...form, osId: e.target.value })} required /></label>
      <label>Seguradora <select value={form.insurerId} onChange={(e) => setForm({ ...form, insurerId: e.target.value })} required><option value="">Selecione</option>{ins.data?.insurers.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
      <label>Nº do sinistro <input value={form.claimNo} onChange={(e) => setForm({ ...form, claimNo: e.target.value })} required pattern="[A-Za-z0-9._/\-]{3,40}" /></label>
      <label>Franquia (R$) <input value={form.deductible} onChange={(e) => setForm({ ...form, deductible: e.target.value })} inputMode="decimal" /></label>
      <label>Valor solicitado (R$) <input value={form.requested} onChange={(e) => setForm({ ...form, requested: e.target.value })} inputMode="decimal" /></label>
      <button type="submit">Abrir</button></form>
    <h3>Sinistros</h3>
    {!claims.data ? <p className="muted">Carregando…</p> : claims.data.claims.length === 0 ? <p className="muted">Nenhum sinistro.</p> :
      <table><thead><tr><th scope="col">Nº</th><th scope="col">Seguradora</th><th scope="col">Situação</th><th scope="col">Prazo</th><th scope="col">Solicitado</th><th scope="col">Autorizado</th><th scope="col">Ações</th></tr></thead>
        <tbody>{claims.data.claims.map((k) => <tr key={k.id}><td>{k.claimNo}</td><td>{insName_(k.insurerId)}</td><td>{CLAIM_STATUS[k.status] ?? k.status}</td><td>{DEADLINE[k.deadline] ?? k.deadline} {k.authorizationDueAt ? `(${dt(k.authorizationDueAt)})` : ""}</td><td>{money(k.requestedCents)}</td><td>{money(k.authorizedCents)}</td>
          <td>
            {(k.status === "opened" || k.status === "partially_authorized") && <button className="secondary" onClick={() => { const v = ask("Valor a solicitar (R$)"); if (v) run(() => api("POST", `/claims/${k.id}/request-authorization`, { requestedCents: toCents(v) }), "Autorização solicitada."); }}>Solicitar autorização</button>}
            {k.status === "awaiting_authorization" && <button className="secondary" onClick={() => { const v = ask("Valor autorizado pela seguradora (R$) — 0 = negado"); if (v) run(() => api("POST", `/claims/${k.id}/authorization`, { authorizedCents: toCents(v) }), "Resposta registrada."); }}>Registrar resposta</button>}
            {["authorized", "partially_authorized", "denied"].includes(k.status) && <button className="secondary" onClick={() => run(() => api("POST", `/claims/${k.id}/status`, { to: "completed" }), "Sinistro concluído.")}>Concluir</button>}
            {k.status === "completed" && <button className="secondary" onClick={() => run(() => api("POST", `/claims/${k.id}/status`, { to: "paid" }), "Marcado como pago.")}>Marcar pago</button>}
          </td></tr>)}</tbody></table>}
    <p className="muted">Cada rodada de autorização fica registrada e não pode ser alterada.</p>
  </div>);
}

function Comissoes() {
  const rules = useLoad<{ rules: any[] }>("/commissions/rules"); const entries = useLoad<{ entries: any[] }>("/commissions/entries");
  const [member, setMember] = useState(""); const [bal, setBal] = useState<any>(null); const [err, setErr] = useState("");
  const showBalance = async (ev: React.FormEvent) => { ev.preventDefault(); try { setBal(await api("GET", `/commissions/balance?membershipId=${member.trim()}`)); setErr(""); } catch (e) { setErr(errText(e)); } };
  return (<div>
    {(rules.err || entries.err || err) && <p className="error" role="alert">{rules.err || entries.err || err}</p>}
    <p className="muted">Comissões e adiantamentos <strong>não substituem a folha de pagamento</strong>; consulte seu contador (encargos, reflexos).</p>
    <h3>Saldo de um colaborador</h3>
    <form className="row" onSubmit={showBalance}><label>ID do colaborador <input value={member} onChange={(e) => setMember(e.target.value)} required /></label><button type="submit">Consultar</button></form>
    {bal && <pre className="muted" aria-label="Saldo">{JSON.stringify(Object.fromEntries(Object.entries(bal).map(([k, v]) => [k, typeof v === "number" && /cents/i.test(k) ? money(v) : v])), null, 2)}</pre>}
    <h3>Regras vigentes (versionadas)</h3>
    {!rules.data ? <p className="muted">Carregando…</p> : rules.data.rules.length === 0 ? <p className="muted">Nenhuma regra.</p> :
      <table><thead><tr><th scope="col">Colaborador</th><th scope="col">Versão</th><th scope="col">Base</th><th scope="col">Taxa</th><th scope="col">Vigência</th></tr></thead>
        <tbody>{rules.data.rules.map((r) => <tr key={r.id}><td>{r.membership_id.slice(0, 8)}…</td><td>{r.version_no}</td><td>{r.basis === "os_margin" ? "Margem da OS" : "Receita líquida da OS"}</td><td>{(r.rate_bps / 100).toFixed(2)}%</td><td>{dt(r.valid_from)}</td></tr>)}</tbody></table>}
    <h3>Lançamentos recentes</h3>
    {!entries.data ? null : entries.data.entries.length === 0 ? <p className="muted">Nenhum lançamento.</p> :
      <table><thead><tr><th scope="col">Data</th><th scope="col">Tipo</th><th scope="col">Base</th><th scope="col">Valor</th></tr></thead>
        <tbody>{entries.data.entries.slice(0, 50).map((e) => <tr key={e.id}><td>{dt(e.created_at)}</td><td>{e.kind}</td><td>{money(Number(e.basis_cents))}</td><td>{money(Number(e.amount_cents))}</td></tr>)}</tbody></table>}
  </div>);
}

function Agenda() {
  const wl = useLoad<{ entries: any[] }>("/agenda/waitlist"); const cu = useLoad<{ customers: any[] }>("/customers");
  const [f, setF] = useState({ customerId: "", title: "", duration: "60", from: "", to: "" }); const [msg, setMsg] = useState("");
  const add = async (ev: React.FormEvent) => { ev.preventDefault(); try { await api("POST", "/agenda/waitlist", { customerId: f.customerId, title: f.title, durationMinutes: Number(f.duration), windowFrom: new Date(f.from).toISOString(), windowTo: new Date(f.to).toISOString() }); setMsg("Adicionado à lista de espera."); wl.load(); } catch (e) { setMsg(errText(e)); } };
  const cancel = async (id: string) => { try { await api("POST", `/agenda/waitlist/${id}/cancel`); wl.load(); } catch (e) { setMsg(errText(e)); } };
  return (<div>
    {(wl.err || msg) && <p className="error" role="alert">{wl.err || msg}</p>}
    <h3>Adicionar à lista de espera</h3>
    <form className="row" onSubmit={add}>
      <label>Cliente <select value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })} required><option value="">Selecione</option>{cu.data?.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Serviço <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={2} /></label>
      <label>Duração (min) <input type="number" min={15} step={15} value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })} /></label>
      <label>Disponível de <input type="datetime-local" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} required /></label>
      <label>até <input type="datetime-local" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} required /></label>
      <button type="submit">Adicionar</button></form>
    <h3>Lista de espera</h3>
    {!wl.data ? <p className="muted">Carregando…</p> : wl.data.entries.length === 0 ? <p className="muted">Ninguém na espera.</p> :
      <table><thead><tr><th scope="col">Serviço</th><th scope="col">Duração</th><th scope="col">Janela</th><th scope="col">Situação</th><th scope="col">Ações</th></tr></thead>
        <tbody>{wl.data.entries.map((e) => <tr key={e.id}><td>{e.title}</td><td>{e.duration_minutes} min</td><td>{dt(e.window_from)} → {dt(e.window_to)}</td><td>{e.status === "waiting" ? "Aguardando" : e.status}</td>
          <td>{e.status === "waiting" && <button className="secondary" onClick={() => cancel(e.id)}>Cancelar</button>}</td></tr>)}</tbody></table>}
    <p className="muted">O cliente não é avisado automaticamente (KI-083): ao liberar um horário, consulte os encaixes possíveis e avise por telefone/WhatsApp.</p>
  </div>);
}

function Transferencias() {
  const tr = useLoad<{ transfers: any[] }>("/stock/transfers");
  return (<div>
    {tr.err && <p className="error" role="alert">{tr.err}</p>}
    {!tr.data ? <p className="muted">Carregando…</p> : tr.data.transfers.length === 0 ? <p className="muted">Nenhuma transferência.</p> :
      <table><thead><tr><th scope="col">Data</th><th scope="col">Origem</th><th scope="col">Destino</th><th scope="col">Observação</th></tr></thead>
        <tbody>{tr.data.transfers.map((t) => <tr key={t.id}><td>{dt(t.created_at)}</td><td>{t.from_unit_id.slice(0, 8)}…</td><td>{t.to_unit_id.slice(0, 8)}…</td><td>{t.note ?? "—"}</td></tr>)}</tbody></table>}
    <p className="muted">Criar transferências ainda é feito pela API (<code>POST /stock/transfers</code>, com chave de idempotência e itens); a tela mostra o histórico. A transferência é imediata, sem “em trânsito” (KI-080).</p>
  </div>);
}
