import { useState } from "react";
import {
  api,
  type Backup,
  type Cert,
  type Cost,
  type Deploy,
  type HealthSample,
  type Incident,
  type Runbook,
  type Service,
} from "./api";
import { useLoader } from "./App";
import { Sparkline, NumberSpark } from "./Sparkline";

export function Ops({ project }: { project?: string }) {
  const [services] = useLoader<Service[]>(() => api.services(project), [project]);
  const [incidents, refetchIncidents] = useLoader<Incident[]>(() => api.incidents(true), [project]);
  const [deploys] = useLoader<Deploy[]>(() => api.deploys(project), [project]);
  const [certs] = useLoader<Cert[]>(() => api.certs(project), [project]);
  const [backups] = useLoader<Backup[]>(() => api.backups(project), [project]);
  const [costs] = useLoader<Cost[]>(() => api.costs(project), [project]);

  const openIncidents = (incidents ?? []).filter(
    (i) => !project || (services ?? []).some((s) => s.name === i.service),
  );

  return (
    <div className="ops">
      {/* Open incidents first (red), each with a runbook link */}
      {openIncidents.length > 0 && (
        <div className="incident-banner">
          {openIncidents.map((i) => (
            <IncidentRow key={i.id} incident={i} onResolved={refetchIncidents} />
          ))}
        </div>
      )}

      {/* Service grid: status-dot, uptime 24h, latency, cost/mo */}
      <div className="grid">
        {(services ?? []).map((s) => (
          <ServiceCard key={s.id} svc={s} />
        ))}
        {services && services.length === 0 && <div className="muted">No services.</div>}
      </div>

      <div className="cols2">
        <DeploysPanel deploys={deploys} />
        <CostTrendPanel costs={costs} />
      </div>

      <div className="cols2">
        <CertsPanel certs={certs} />
        <BackupsPanel backups={backups} />
      </div>
    </div>
  );
}

// SQLite stores UTC 'YYYY-MM-DD HH:MM:SS' (or bare date). Parse as UTC → epoch ms.
function parseUtc(s: string): number {
  const iso = (s.length > 10 ? s.replace(" ", "T") : `${s}T00:00:00`) + "Z";
  return new Date(iso).getTime();
}

function ServiceCard({ svc }: { svc: Service }) {
  const [samples] = useLoader<HealthSample[]>(
    () => (svc.health_url ? api.healthHistory(svc.name, 24) : Promise.resolve([])),
    [svc.name],
  );
  const s = samples ?? [];
  const up = s.filter((x) => x.status !== "down").length;
  const uptime = s.length ? Math.round((up / s.length) * 100) : null;
  const st = svc.health?.status ?? "";
  const cost = svc.cost_month != null ? `${svc.cost_month}${svc.currency ? " " + svc.currency : ""}/mo` : "—";
  return (
    <div className="svc">
      <div className="name">
        <span className={`dot ${st}`} title={svc.health?.status ?? "unknown"} />
        {svc.dashboard_url ? (
          <a href={svc.dashboard_url} target="_blank" rel="noreferrer">
            {svc.name}
          </a>
        ) : (
          svc.name
        )}
      </div>
      <div className="stats">
        <span>
          uptime <b>{uptime == null ? "—" : `${uptime}%`}</b>
        </span>
        <span>
          latency <b>{svc.health ? `${svc.health.latency_ms}ms` : "—"}</b>
        </span>
        <span>
          cost <b>{cost}</b>
        </span>
      </div>
      {svc.health_url && s.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <Sparkline samples={s} width={205} height={26} />
        </div>
      )}
    </div>
  );
}

function DeploysPanel({ deploys }: { deploys?: Deploy[] }) {
  const rows = deploys ?? [];
  return (
    <div className="panel">
      <h2>Recent deploys</h2>
      {rows.length === 0 && <div className="muted">No deploys.</div>}
      {rows.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>SHA</th>
              <th>Env</th>
              <th>Status</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td className="mono">{d.sha.slice(0, 8)}</td>
                <td>{d.env}</td>
                <td>
                  <span className={`pill ${d.status}`}>{d.status}</span>
                </td>
                <td className="muted">{d.ts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CostTrendPanel({ costs }: { costs?: Cost[] }) {
  const byService = new Map<string, Cost[]>();
  for (const c of costs ?? []) byService.set(c.service, [...(byService.get(c.service) ?? []), c]);
  return (
    <div className="panel">
      <h2>Cost trend</h2>
      {byService.size === 0 && <div className="muted">No cost data.</div>}
      {[...byService.entries()].map(([service, cs]) => {
        const sorted = [...cs].sort((a, b) => a.month.localeCompare(b.month));
        const latest = sorted[sorted.length - 1];
        return (
          <div className="ms" key={service}>
            <div className="row">
              <span>{service}</span>
              <span className="muted">{latest ? `${latest.amount} · ${latest.month}` : ""}</span>
            </div>
            <NumberSpark values={sorted.map((c) => c.amount)} width={280} height={30} />
          </div>
        );
      })}
    </div>
  );
}

function CertsPanel({ certs }: { certs?: Cert[] }) {
  const rows = certs ?? [];
  return (
    <div className="panel">
      <h2>Certs</h2>
      {rows.length === 0 && <div className="muted">No certificates.</div>}
      {rows.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Domain</th>
              <th>Expires</th>
              <th>Left</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const days = c.expires_at ? Math.floor((parseUtc(c.expires_at) - Date.now()) / 86_400_000) : null;
              const warn = days != null && days <= 14;
              return (
                <tr key={c.id}>
                  <td className="mono">{c.domain}</td>
                  <td className="muted">{c.expires_at ?? "—"}</td>
                  <td className={warn ? "warn" : ""}>
                    {days == null ? "—" : days < 0 ? `${-days}d ago ⚠` : `${days}d${warn ? " ⚠" : ""}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function BackupsPanel({ backups }: { backups?: Backup[] }) {
  const rows = backups ?? [];
  return (
    <div className="panel">
      <h2>Backups</h2>
      {rows.length === 0 && <div className="muted">No backups.</div>}
      {rows.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Target</th>
              <th>Last OK</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const hours = b.last_ok_at ? Math.floor((Date.now() - parseUtc(b.last_ok_at)) / 3_600_000) : null;
              const warn = hours == null || hours > 48;
              return (
                <tr key={b.id}>
                  <td className="mono">{b.target}</td>
                  <td className="muted">{b.last_ok_at ?? "never"}</td>
                  <td className={warn ? "warn" : ""}>
                    {hours == null ? "never ⚠" : hours > 48 ? `${hours}h ⚠` : `${hours}h`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function IncidentRow({ incident, onResolved }: { incident: Incident; onResolved: () => void }) {
  const [runbooks, setRunbooks] = useState<Runbook[] | null>(null);
  const [show, setShow] = useState(false);
  const toggleRunbook = async () => {
    if (runbooks == null) setRunbooks(await api.runbooks(incident.service).catch(() => []));
    setShow((v) => !v);
  };
  const resolve = async () => {
    await api.resolveIncident(incident.id, "resolved from panel");
    onResolved();
  };
  return (
    <div>
      <div className="inc">
        <span className={`sev ${incident.severity}`}>{incident.severity}</span>
        <b>{incident.service}</b>
        <span>{incident.title}</span>
        <span className="muted">· {incident.started_at}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <button onClick={toggleRunbook}>Runbook</button>
        <button onClick={resolve}>Resolve</button>
      </div>
      {show && (
        <div className="muted" style={{ padding: "2px 0 8px 44px" }}>
          {runbooks && runbooks.length > 0 ? (
            runbooks.map((r) => (
              <div key={r.id}>
                <b>{r.title}</b>
                <div className="mono" style={{ whiteSpace: "pre-wrap" }}>
                  {r.body_md}
                </div>
              </div>
            ))
          ) : (
            <em>No runbook for {incident.service}.</em>
          )}
        </div>
      )}
    </div>
  );
}
