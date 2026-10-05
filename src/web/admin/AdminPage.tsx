import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { TokenGate } from './TokenGate';

interface VersionsResponse {
  funnelId: string;
  activeVersion: number | null;
  versions: { version: number; checksum: string; release_note: string | null; created_at: string; sessions: number; active: boolean }[];
  log: { version: number; from_version: number | null; action: string; created_at: string }[];
}

const fmt = (iso: string) => new Date(iso).toLocaleString('ru-RU');

export function AdminPage() {
  const [funnelId, setFunnelId] = useState<string | null>(null);
  const [data, setData] = useState<VersionsResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [upload, setUpload] = useState('');
  const [publishOnUpload, setPublishOnUpload] = useState(true);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<{ version: number; json: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const id = funnelId ?? (await api<{ funnels: string[] }>('/api/admin/funnels')).funnels[0];
      if (!id) return;
      setFunnelId(id);
      setData(await api<VersionsResponse>(`/api/admin/funnels/${id}/versions`));
    } catch (e) {
      setError(e as ApiError);
    }
  }, [funnelId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      setFlash(label);
      await load();
    } catch (e) {
      setFlash(`Ошибка: ${(e as Error).message}`);
    }
  };

  const submitUpload = async () => {
    setUploadErrors([]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(upload);
    } catch {
      setUploadErrors(['Не JSON']);
      return;
    }
    try {
      const r = await api<{ version: number; created: boolean }>(`/api/admin/versions${publishOnUpload ? '?publish=1' : ''}`, {
        method: 'POST',
        json: parsed,
      });
      setFlash(`Версия ${r.version} ${r.created ? 'загружена' : 'уже была загружена'}${publishOnUpload ? ' и опубликована' : ''}`);
      setUpload('');
      await load();
    } catch (e) {
      const err = e as ApiError;
      setUploadErrors(Array.isArray(err.details) ? (err.details as string[]) : [err.message]);
    }
  };

  if (error?.status === 401) return <TokenGate onSaved={load} />;

  const prev = data?.log.find((l) => l.version === data.activeVersion && l.action === 'publish' && l.from_version !== null);

  return (
    <div className="page">
      <h1>Версии воронки</h1>
      {error && <p className="error">{error.message}</p>}
      {flash && (
        <p className="flash" onClick={() => setFlash(null)}>
          {flash}
        </p>
      )}
      {data && (
        <>
          <section className="panel">
            <div className="row between">
              <div>
                <p className="muted small">Воронка</p>
                <h2>{data.funnelId}</h2>
                <p>
                  Активная версия: <b className="badge active">v{data.activeVersion ?? '—'}</b> — на неё попадают только новые
                  сессии. Начатые сессии доигрывают на своей версии.
                </p>
              </div>
              <div className="col gap">
                <button
                  className="btn"
                  disabled={!prev}
                  onClick={() => {
                    if (confirm(`Откатить на v${prev!.from_version}?`))
                      void act(`Откат на v${prev!.from_version}`, () => api(`/api/admin/funnels/${data.funnelId}/rollback`, { method: 'POST' }));
                  }}
                >
                  ↶ Откатить{prev ? ` на v${prev.from_version}` : ''}
                </button>
                <a className="btn ghost" href="/?variant=A" target="_blank" rel="noreferrer">
                  Открыть вариант A
                </a>
                <a className="btn ghost" href="/?variant=B" target="_blank" rel="noreferrer">
                  Открыть вариант B
                </a>
              </div>
            </div>
          </section>

          <section className="panel">
            <h2>Хранилище версий</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>Версия</th>
                  <th>Описание релиза</th>
                  <th>Загружена</th>
                  <th className="num">Сессий</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.versions.map((v) => (
                  <tr key={v.version} className={v.active ? 'is-active' : ''}>
                    <td>
                      v{v.version} {v.active && <span className="badge active">active</span>}
                    </td>
                    <td className="muted">{v.release_note ?? '—'}</td>
                    <td className="muted small">{fmt(v.created_at)}</td>
                    <td className="num">{v.sessions}</td>
                    <td className="actions">
                      <button
                        className="btn small ghost"
                        onClick={async () =>
                          setPreview({
                            version: v.version,
                            json: JSON.stringify(await api(`/api/admin/funnels/${data.funnelId}/versions/${v.version}`), null, 2),
                          })
                        }
                      >
                        JSON
                      </button>
                      {!v.active && (
                        <button
                          className="btn small"
                          onClick={() =>
                            void act(`Опубликована v${v.version}`, () =>
                              api(`/api/admin/funnels/${data.funnelId}/publish`, { method: 'POST', json: { version: v.version } }),
                            )
                          }
                        >
                          Опубликовать
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <h2>Загрузить новую версию</h2>
            <p className="muted small">
              Конфиг валидируется на сервере (ссылки на шаги, условия, результаты, обязательные события). Номер версии должен
              быть новым; тот же номер с другим содержимым отклоняется.
            </p>
            <input
              type="file"
              accept="application/json,.json"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setUpload(await file.text());
              }}
            />
            <textarea
              className="code"
              rows={8}
              placeholder='{"funnelId": "...", "version": 3, ...}'
              value={upload}
              onChange={(e) => setUpload(e.target.value)}
            />
            <label className="row gap small">
              <input type="checkbox" checked={publishOnUpload} onChange={(e) => setPublishOnUpload(e.target.checked)} />
              Сразу опубликовать
            </label>
            {uploadErrors.length > 0 && (
              <ul className="error">
                {uploadErrors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            <button className="btn primary" disabled={!upload.trim()} onClick={() => void submitUpload()}>
              Загрузить
            </button>
          </section>

          <section className="panel">
            <h2>Журнал публикаций</h2>
            <table className="table">
              <tbody>
                {data.log.map((l, i) => (
                  <tr key={i}>
                    <td className="muted small">{fmt(l.created_at)}</td>
                    <td>{l.action === 'publish' ? 'Публикация' : 'Откат'}</td>
                    <td>
                      {l.from_version !== null ? `v${l.from_version} → ` : ''}v{l.version}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {preview && (
            <section className="panel">
              <div className="row between">
                <h2>v{preview.version}</h2>
                <button className="btn small ghost" onClick={() => setPreview(null)}>
                  Закрыть
                </button>
              </div>
              <pre className="code">{preview.json}</pre>
            </section>
          )}
        </>
      )}
    </div>
  );
}
