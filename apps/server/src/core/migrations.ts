/**
 * 버전 순서대로 한 번씩만 적용. 이미 배포된 항목은 절대 수정하지 말고 새 버전을 추가합니다.
 * SQL을 TS 문자열로 두는 이유: 단일 exe에 그대로 포함되게 하려고.
 */
export const migrations: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'init',
    sql: `
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL            -- JSON
      );

      CREATE TABLE viewers (
        id                  TEXT PRIMARY KEY,   -- 'chzzk:<id>'
        nickname            TEXT NOT NULL,
        roles               TEXT NOT NULL DEFAULT '[]',
        first_seen          INTEGER NOT NULL,
        last_seen           INTEGER NOT NULL,
        points              INTEGER NOT NULL DEFAULT 0,
        roulette_carry_krw  INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE donations (
        id          TEXT PRIMARY KEY,           -- envelope id
        ts          INTEGER NOT NULL,
        source      TEXT NOT NULL,
        viewer_id   TEXT,                       -- NULL = 익명
        nickname    TEXT,
        amount_krw  INTEGER NOT NULL,
        text        TEXT,
        kind        TEXT NOT NULL,
        dedup_key   TEXT NOT NULL
      );
      CREATE INDEX donations_dedup ON donations(dedup_key, ts);

      CREATE TABLE events_log (
        id       TEXT PRIMARY KEY,
        ts       INTEGER NOT NULL,
        source   TEXT NOT NULL,
        type     TEXT NOT NULL,
        payload  TEXT NOT NULL                  -- JSON (Envelope)
      );
      CREATE INDEX events_log_ts ON events_log(ts);
    `,
  },
];
