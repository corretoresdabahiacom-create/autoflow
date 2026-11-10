import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { api, errText } from "./api";
import { Kanban } from "./Kanban";

type View = { name: "login" } | { name: "board" } | { name: "home" } | { name: "new" } | { name: "order"; id: string };
const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const STATUS_LABEL: Record<string, string> = { pending: "pendente", approved: "aprovado", approved_inherited: "aprovado (herdado)", rejected: "recusado" };

function useOnline() {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const u = () => setOn(true), d = () => setOn(false);
    addEventListener("online", u); addEventListener("offline", d);
    return () => { removeEventListener("online", u); removeEventListener("offline", d); };
  }, []);
  return on;
}

/** Estados padrão: carregando / erro (com tentar de novo) / vazio. */
function Async<T>({ load, deps, empty, children }: { load: () => Promise<T>; deps: unknown[]; empty?: (d: T) => boolean; children: (d: T, reload: () => void) => ReactNode }) {
  const [state, setState] = useState<{ s: "loading" } | { s: "error"; msg: string } | { s: "ok"; d: T }>({ s: "loading" });
  const run = useCallback(() => {
    setState({ s: "loading" });
    load().then((d) => setState({ s: "ok", d })).catch((e) => setState({ s: "error", msg: errText(e) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(run, [run]);
  if (state.s === "loading") return <p role="status" className="muted">Carregando…</p>;
  if (state.s === "error") return <div className="card"><p className="error" role="alert">{state.msg}</p><button onClick={run}>Tentar de novo</button></div>;
  if (empty?.(state.d)) return <p className="muted">Nada encontrado.</p>;
  return <>{children(state.d, run)}</>;
}

function Login({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ tenantSlug: "", email: "", password: "", mfaCode: "" });
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false); const [needMfa, setNeedMfa] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { await api("POST", "/auth/login", { ...f, mfaCode: f.mfaCode || undefined }); onDone(); }
    catch (x: any) { if (x.code === "mfa_required") setNeedMfa(true); setErr(errText(x)); }
    finally { setBusy(false); }
  };
  return (
    <main><h1>Entrar</h1>
      <form className="card" onSubmit={submit}>
        <label>Oficina (identificador)<input required value={f.tenantSlug} onChange={(e) => setF({ ...f, tenantSlug: e.target.value })} autoCapitalize="none" /></label>
        <label>E-mail<input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="username" /></label>
        <label>Senha<input required type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="current-password" /></label>
        {needMfa && <label>Código do autenticador<input inputMode="numeric" pattern="\d{6}" value={f.mfaCode} onChange={(e) => setF({ ...f, mfaCode: e.target.value })} autoComplete="one-time-code" /></label>}
        {err && <p className="error" role="alert">{err}</p>}
        <button disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
      </form></main>
  );
}

function Home({ go }: { go: (v: View) => void }) {
  const [q, setQ] = useState(""); const [term, setTerm] = useState("");
  return (
    <main>
      <div className="row"><h1>Atendimento</h1><button className="secondary" onClick={() => go({ name: "board" })}>Produção</button><button onClick={() => go({ name: "new" })}>Nova OS</button></div>
      <form className="card" role="search" onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }}>
        <label>Buscar por placa, telefone, nome ou nº da OS<input value={q} onChange={(e) => setQ(e.target.value)} enterKeyHint="search" /></label>
        <button>Buscar</button>
      </form>
      {term ? (
        <Async key={`s:${term}`} load={() => api("GET", `/search?q=${encodeURIComponent(term)}`)} deps={[term]} empty={(d) => !d.customers.length && !d.vehicles.length && !d.orders.length}>
          {(d) => (<>
            {d.orders.length > 0 && <><h2>Ordens de serviço</h2><ul className="list">{d.orders.map((o: any) => <li key={o.id}><a href="#" onClick={(e) => { e.preventDefault(); go({ name: "order", id: o.id }); }}>OS {o.number} · {o.plate} · {o.customer_name}</a></li>)}</ul></>}
            {d.vehicles.length > 0 && <><h2>Veículos</h2><ul className="list">{d.vehicles.map((v: any) => <li key={v.id}>{v.plate} {v.model} · {v.customer_name}</li>)}</ul></>}
            {d.customers.length > 0 && <><h2>Clientes</h2><ul className="list">{d.customers.map((c: any) => <li key={c.id}>{c.name} <span className="muted">{c.phone_e164}</span></li>)}</ul></>}
          </>)}
        </Async>
      ) : (
        <Async key="open" load={() => api("GET", "/orders?status=open")} deps={[]} empty={(d) => !d.orders.length}>
          {(d) => (<><h2>OS abertas</h2><ul className="list">{d.orders.map((o: any) => <li key={o.id}><a href="#" onClick={(e) => { e.preventDefault(); go({ name: "order", id: o.id }); }}>OS {o.number} · {o.plate} · {o.customer_name}</a></li>)}</ul></>)}
        </Async>
      )}
    </main>
  );
}

function NewOrder({ go }: { go: (v: View) => void }) {
  const [f, setF] = useState({ name: "", phone: "", plate: "", make: "", model: "" });
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const c = await api("POST", "/customers", { name: f.name, phone: f.phone || undefined });
      const v = await api("POST", `/customers/${c.id}/vehicles`, { plate: f.plate, make: f.make || undefined, model: f.model || undefined });
      const o = await api("POST", "/orders", { customerId: c.id, vehicleId: v.id });
      go({ name: "order", id: o.id });
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  return (
    <main><h1>Nova OS</h1>
      <form className="card" onSubmit={submit}>
        <label>Nome do cliente<input required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Telefone (DDD + número)<input inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
        <label>Placa<input required value={f.plate} onChange={(e) => setF({ ...f, plate: e.target.value })} autoCapitalize="characters" /></label>
        <label>Marca<input value={f.make} onChange={(e) => setF({ ...f, make: e.target.value })} /></label>
        <label>Modelo<input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></label>
        {err && <p className="error" role="alert">{err}</p>}
        <div className="row"><button type="button" className="secondary" onClick={() => go({ name: "home" })}>Voltar</button><button disabled={busy}>{busy ? "Criando…" : "Criar OS"}</button></div>
      </form></main>
  );
}

function Order({ id, go }: { id: string; go: (v: View) => void }) {
  return (
    <main>
      <button className="secondary" onClick={() => go({ name: "home" })}>← Voltar</button>
      <Async load={() => api("GET", `/orders/${id}`)} deps={[id]}>
        {(o) => (<>
          <h1>OS {o.number} · {o.plate}</h1>
          <p className="muted">{o.customer_name} · {o.make} {o.model} · {o.status}</p>
          <Estimate id={id} />
        </>)}
      </Async>
    </main>
  );
}

function Estimate({ id }: { id: string }) {
  const [item, setItem] = useState({ description: "", qty: "1", price: "" });
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, reload: () => void) => {
    setBusy(true); setErr("");
    try { await fn(); reload(); } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  return (
    <Async load={() => api("GET", `/orders/${id}/estimate`)} deps={[id]}>
      {(d, reload) => {
        const draft = d.versions.find((v: any) => v.status === "draft");
        const pub = d.versions.find((v: any) => v.status === "published");
        const shown = draft ?? pub;
        return (<>
          <h2>Orçamento {shown ? `v${shown.versionNo} (${shown.status === "draft" ? "rascunho" : "publicado"})` : ""}</h2>
          {!shown && <p className="muted">Nenhum item ainda.</p>}
          {shown && <ul className="list">{shown.items.map((i: any) => (
            <li key={i.id}><div className="row"><span>{i.description} · {i.qty} × {brl(i.unitPriceCents)}</span><span className={`badge ${i.status}`}>{STATUS_LABEL[i.status]}</span></div>
              {shown.status === "published" && i.status === "pending" && (
                <div className="row">
                  <button disabled={busy} onClick={() => act(() => api("POST", `/orders/${id}/estimate/decisions`, { customerName: prompt("Nome de quem decidiu:") ?? "", decisions: [{ itemId: i.id, decision: "approved" }] }), reload)}>Aprovar</button>
                  <button className="secondary" disabled={busy} onClick={() => act(() => api("POST", `/orders/${id}/estimate/decisions`, { customerName: prompt("Nome de quem decidiu:") ?? "", decisions: [{ itemId: i.id, decision: "rejected", justification: prompt("Motivo da recusa:") ?? "" }] }), reload)}>Recusar</button>
                </div>)}
            </li>))}</ul>}
          <form className="card" onSubmit={(e) => { e.preventDefault(); act(() => api("POST", `/orders/${id}/estimate/items`, { description: item.description, category: "service", qty: Number(item.qty), unitPriceCents: Math.round(Number(item.price.replace(",", ".")) * 100) }).then(() => setItem({ description: "", qty: "1", price: "" })), reload); }}>
            <label>Descrição<input required minLength={2} value={item.description} onChange={(e) => setItem({ ...item, description: e.target.value })} /></label>
            <div className="row"><label>Qtd<input required inputMode="decimal" value={item.qty} onChange={(e) => setItem({ ...item, qty: e.target.value })} /></label>
              <label>Preço (R$)<input required inputMode="decimal" value={item.price} onChange={(e) => setItem({ ...item, price: e.target.value })} /></label></div>
            {err && <p className="error" role="alert">{err}</p>}
            <div className="row"><button disabled={busy}>Adicionar item</button>
              {draft && <button type="button" className="secondary" disabled={busy} onClick={() => act(() => api("POST", `/orders/${id}/estimate/publish`), reload)}>Publicar versão</button>}</div>
          </form>
        </>);
      }}
    </Async>
  );
}

export function App() {
  const online = useOnline();
  const [view, setView] = useState<View | null>(null);
  useEffect(() => { api("GET", "/auth/me").then(() => setView({ name: "home" })).catch(() => setView({ name: "login" })); }, []);
  const logout = async () => { await api("POST", "/auth/logout").catch(() => undefined); setView({ name: "login" }); };
  return (<>
    {!online && <div className="banner" role="status">Você está offline. Ações exigem conexão.</div>}
    <header><strong>AutoFlow</strong>{view && view.name !== "login" && <button className="secondary" onClick={logout}>Sair</button>}</header>
    {!view && <main><p role="status" className="muted">Carregando…</p></main>}
    {view?.name === "login" && <Login onDone={() => setView({ name: "home" })} />}
    {view?.name === "home" && <Home go={setView} />}
    {view?.name === "board" && <Kanban onOpen={(id) => setView({ name: "order", id })} onBack={() => setView({ name: "home" })} />}
    {view?.name === "new" && <NewOrder go={setView} />}
    {view?.name === "order" && <Order id={view.id} go={setView} />}
  </>);
}
