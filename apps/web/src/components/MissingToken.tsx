export function MissingToken() {
  return (
    <div className="missing-token">
      <div className="material missing-token__card">
        <h1>Mapbox token required</h1>
        <p>
          Copy <code>apps/web/.env.example</code> to <code>apps/web/.env.local</code>, set{' '}
          <code>VITE_MAPBOX_TOKEN</code> to a public Mapbox token, and restart the dev server.
        </p>
      </div>
    </div>
  );
}
