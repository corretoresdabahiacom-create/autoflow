import { useEffect, useState } from "react";
import { api, errText } from "./api";

const money = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const monthRange = () => { const d = new Date(); const f = new Date(d.getFullYear(), d.getMonth(), 1); const l = new Date(d.getFullYear(), d.getMonth() + 1, 0); const x = (v: Date) => `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`; return `from=${x(f)}&to=${x(l)}`; };

/** AVANÇADO (UI mínima, KI-085): consolidado por unidade (respeita o escopo), sinistros em atraso e automações. Recursos Premium: o backend nega sem o plano. */
export function Avancado({ onBack }: { onBack: () => void }) {
  const [cons, setCons] = useState<any>(null); const [late, setLate] = useState<any[] | null>(null); const [auto, setAuto] = useState<any>(null); const [err, setErr] = useState("");
  const load = async () => {
    try { setCons(await api("GET", `/reports/consolidated?${monthRange()}`)); } catch (e) { setErr(errText(e)); }
    try { setLate((await api("GET", "/claims?deadline=overdue")).claims); } catch { setLate(null); }
    try { setAuto(await api("GET", "/automation/settings")); } catch { setAuto(null); }
  };
  useEffect(() => { load(); }, []);
  const toggle = async () => { try { await api("PUT", "/automation/settings", { enabled: !auto.enabled }); load(); } catch (e) { setErr(errText(e)); } };
  return (
    <main><div className="row"><button className="secondary" onClick={onBack}>← Voltar</button><h1>Avançado</h1></div>
      {err && <p className="error" role="alert">{err}</p>}
      {cons && <section className="card"><h2>Consolidado do mês ({cons.scope === "all" ? "todas as unidades" : "unidades do seu escopo"})</h2>
        <table><thead><tr><th>Unidade</th><th>Receita</th><th>Custos diretos</th><th>Resultado operacional</th><th>Estoque</th></tr></thead>
          <tbody>{cons.units.map((u: any) => <tr key={u.unitId}><td>{u.name}</td><td>{money(u.dre.grossRevenue)}</td><td>{money(u.dre.directCosts)}</td><td>{money(u.dre.operatingResult)}</td><td>{money(u.stockValueCents)}</td></tr>)}
            <tr><th>Total</th><th>{money(cons.total.dre.grossRevenue)}</th><th>{money(cons.total.dre.directCosts)}</th><th>{money(cons.total.dre.operatingResult)}</th><th>{money(cons.total.stockValueCents)}</th></tr></tbody></table>
        <p className="muted">{cons.label}</p></section>}
      {late && <section className="card"><h2>Sinistros com prazo de autorização vencido</h2>{late.length === 0 ? <p className="muted">Nenhum.</p> : <ul className="list">{late.map((k) => <li key={k.id}>{k.claimNo} · solicitado {money(k.requestedCents)} · prazo {new Date(k.authorizationDueAt).toLocaleString("pt-BR")}</li>)}</ul>}</section>}
      {auto && <section className="card"><h2>Automações</h2><p>Uso no mês: {auto.usedThisMonth} / {auto.monthlyLimit ?? "ilimitado"} · {auto.platformKillSwitch ? "PAUSADAS pela plataforma" : auto.enabled ? "ativas" : "desligadas por você"}</p>
        <button className="secondary" onClick={toggle}>{auto.enabled ? "Desligar automações (kill-switch da oficina)" : "Ligar automações"}</button></section>}
    </main>
  );
}
