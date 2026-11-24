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
  {
    version: 2,
    name: 'songs_and_roulette',
    sql: `
      CREATE TABLE tracks (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        source          TEXT NOT NULL,            -- youtube | local
        ref             TEXT NOT NULL,            -- videoId | 파일 경로
        title           TEXT NOT NULL,
        artist          TEXT,
        duration_sec    REAL,
        playable        INTEGER,                  -- 1 | 0 | NULL(미검증)
        fail_count      INTEGER NOT NULL DEFAULT 0,
        play_count      INTEGER NOT NULL DEFAULT 0,
        skip_count      INTEGER NOT NULL DEFAULT 0,
        last_played_at  INTEGER,
        UNIQUE(source, ref)
      );

      CREATE TABLE queue (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id        INTEGER NOT NULL REFERENCES tracks(id),
        requester_key   TEXT,
        requester_name  TEXT,
        priority        INTEGER NOT NULL DEFAULT 0,
        position        REAL NOT NULL,
        status          TEXT NOT NULL,
        reason          TEXT,
        via             TEXT NOT NULL,
        paid_krw        INTEGER NOT NULL DEFAULT 0,
        requested_at    INTEGER NOT NULL,
        started_at      INTEGER,
        ended_at        INTEGER
      );
      CREATE INDEX queue_status ON queue(status, priority DESC, position);

      CREATE TABLE stations (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        name    TEXT NOT NULL,
        kind    TEXT NOT NULL,                    -- manual | local | popular
        mode    TEXT NOT NULL DEFAULT 'shuffle',  -- sequential | shuffle
        folder  TEXT,
        cursor  INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE station_tracks (
        station_id  INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
        track_id    INTEGER NOT NULL REFERENCES tracks(id),
        ord         INTEGER NOT NULL,
        PRIMARY KEY(station_id, track_id)
      );

      CREATE TABLE player_state (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        now         TEXT,                         -- JSON NowPlaying
        paused      INTEGER NOT NULL DEFAULT 0,
        volume      INTEGER NOT NULL DEFAULT 60,
        updated_at  INTEGER NOT NULL
      );
      INSERT INTO player_state(id, now, paused, volume, updated_at) VALUES (1, NULL, 0, 60, 0);

      CREATE TABLE op_log (
        id    INTEGER PRIMARY KEY AUTOINCREMENT,
        ts    INTEGER NOT NULL,
        label TEXT NOT NULL,
        undo  TEXT NOT NULL                       -- JSON
      );

      CREATE TABLE roulettes (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        items           TEXT NOT NULL,            -- JSON RouletteItem[]
        trigger         TEXT NOT NULL,            -- JSON RouletteTrigger
        enabled         INTEGER NOT NULL DEFAULT 1,
        chat_template   TEXT NOT NULL,
        track_penalties INTEGER NOT NULL DEFAULT 1,
        sort_order      INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE roulette_spins (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        roulette_id   INTEGER NOT NULL,
        roulette_name TEXT NOT NULL,
        viewer_key    TEXT,
        viewer_name   TEXT,
        amount_krw    INTEGER NOT NULL DEFAULT 0,
        donation_id   TEXT,
        results       TEXT NOT NULL,              -- JSON string[]
        items         TEXT NOT NULL,              -- JSON RouletteItem[] (당시 스냅샷)
        status        TEXT NOT NULL,              -- queued | showing | done
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX roulette_spins_status ON roulette_spins(status, id);
      CREATE TABLE roulette_carry (
        roulette_id  INTEGER NOT NULL,
        viewer_key   TEXT NOT NULL,
        krw          INTEGER NOT NULL,
        PRIMARY KEY(roulette_id, viewer_key)
      );
      CREATE TABLE penalties (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        spin_id      INTEGER NOT NULL,
        label        TEXT NOT NULL,
        viewer_name  TEXT,
        done         INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
      );
    `,
  },
];
