import { useState } from 'react';
import { adminToken } from '../api';

export function TokenGate(props: { onSaved: () => void }) {
  const [value, setValue] = useState(adminToken.get());
  return (
    <div className="page">
      <section className="panel narrow">
        <h1>Нужен admin token</h1>
        <p className="muted">Сервер запущен с ADMIN_TOKEN. Введите его, чтобы открыть внутренние страницы.</p>
        <form
          className="row gap"
          onSubmit={(e) => {
            e.preventDefault();
            adminToken.set(value);
            props.onSaved();
          }}
        >
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          <button className="btn primary">Сохранить</button>
        </form>
      </section>
    </div>
  );
}
