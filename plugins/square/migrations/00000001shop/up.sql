CREATE TABLE square_connections (
  slot TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  merchant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  access_ct TEXT NOT NULL,
  access_iv TEXT NOT NULL,
  refresh_ct TEXT NOT NULL,
  refresh_iv TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  connected_at TEXT NOT NULL
);
CREATE TABLE square_products (
  entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  item_id TEXT NOT NULL,
  UNIQUE (merchant_id, environment, item_id)
);
CREATE TABLE square_oauth (
  id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
