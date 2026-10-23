-- AI IT Consultant – Database Schema
-- Generated: 2026-10-23T21:19:25Z

-- manifest.sqlite3  (c:\Users\kishore\Desktop\raji\labs\Business-Labs\task1-knowledge-brain\data\manifest.sqlite3)
CREATE INDEX refresh_urls_run_index
                ON sitemap_refresh_urls(run_id, url);
CREATE UNIQUE INDEX sitemap_owner_root
                ON sitemap_configs(owner_id, root_url);
CREATE TABLE article_versions (
                url TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                content BLOB NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (url, content_hash)
            );
CREATE TABLE sitemap_configs (
                sitemap_id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                root_url TEXT NOT NULL,
                interval TEXT NOT NULL,
                threshold INTEGER NOT NULL,
                action TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                last_attempted TEXT,
                last_successful TEXT,
                next_scheduled TEXT,
                status TEXT NOT NULL DEFAULT 'idle',
                failure_reason TEXT
            );
CREATE TABLE sitemap_imports (
                    import_id TEXT PRIMARY KEY,
                    source_url TEXT NOT NULL,
                    source_path TEXT,
                    extracted_at TEXT NOT NULL,
                    total_sitemap_urls INTEGER NOT NULL,
                    unique_sitemap_urls INTEGER NOT NULL,
                    article_urls_identified INTEGER NOT NULL,
                    unique_article_urls_saved INTEGER NOT NULL,
                    duplicate_urls_removed INTEGER NOT NULL,
                    rejected_urls INTEGER NOT NULL,
                    rejected_by_reason_json TEXT NOT NULL
                , documents_fetched INTEGER NOT NULL DEFAULT 1);
CREATE TABLE sitemap_membership (
                sitemap_id TEXT NOT NULL,
                url TEXT NOT NULL,
                first_discovered_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                present INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (sitemap_id, url)
            );
CREATE TABLE sitemap_refresh_runs (
                run_id TEXT PRIMARY KEY,
                sitemap_id TEXT NOT NULL,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                status TEXT NOT NULL,
                discovered_count INTEGER NOT NULL DEFAULT 0,
                unique_count INTEGER NOT NULL DEFAULT 0,
                duplicate_count INTEGER NOT NULL DEFAULT 0,
                error_count INTEGER NOT NULL DEFAULT 0,
                pages_processed INTEGER NOT NULL DEFAULT 0,
                pages_total INTEGER NOT NULL DEFAULT 0,
                errors_json TEXT NOT NULL DEFAULT '[]'
            , first_fetched_url TEXT, last_fetched_url TEXT);
CREATE TABLE sitemap_refresh_urls (
                run_id TEXT NOT NULL,
                url TEXT NOT NULL,
                sitemap_id TEXT NOT NULL,
                fetch_status TEXT NOT NULL,
                http_status INTEGER,
                error_summary TEXT,
                sitemap_member INTEGER NOT NULL,
                lifecycle_status TEXT,
                fetched_at TEXT,
                PRIMARY KEY (run_id, url)
            );
CREATE TABLE sitemap_rejected_urls (
                    import_id TEXT NOT NULL,
                    raw_url TEXT NOT NULL,
                    reason TEXT NOT NULL
                );
CREATE TABLE sitemap_source_urls (
                    source_url TEXT NOT NULL,
                    normalized_url TEXT NOT NULL,
                    is_article INTEGER NOT NULL,
                    first_seen_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    last_import_id TEXT NOT NULL,
                    PRIMARY KEY (source_url, normalized_url)
                );
CREATE TABLE sources (
                url TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_modified TEXT,
                content_hash TEXT,
                last_successful_ingestion TEXT,
                error_summary TEXT,
                active INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            , first_discovered_at TEXT, last_seen_at TEXT, last_status_code INTEGER, consecutive_missing_checks INTEGER NOT NULL DEFAULT 0, consecutive_failure_checks INTEGER NOT NULL DEFAULT 0, lifecycle_status TEXT NOT NULL DEFAULT 'active', quarantine_reason TEXT, quarantined_at TEXT);

-- task2.sqlite3  (c:\Users\kishore\Desktop\raji\labs\Business-Labs\task2-inbox-agent\data\local\task2.sqlite3)
CREATE INDEX idx_complaints_owner_status ON complaint_records(owner_id, status, updated_at);
CREATE INDEX idx_draft_audit_owner_email ON draft_audit_events(owner_id, email_id, created_at);
CREATE INDEX idx_email_drafts_current ON email_drafts(owner_id, email_id, version DESC);
CREATE INDEX idx_send_attempts_owner_email ON send_attempts(owner_id, email_id, created_at);
CREATE TABLE complaint_records (
        owner_id TEXT NOT NULL, message_id TEXT NOT NULL, sender TEXT NOT NULL,
        subject TEXT NOT NULL, received_at TEXT, body TEXT NOT NULL,
        status TEXT NOT NULL, analysis_json TEXT, error_detail TEXT,
        updated_at TEXT NOT NULL, PRIMARY KEY (owner_id, message_id)
      );
CREATE TABLE draft_audit_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, email_id TEXT NOT NULL,
        draft_version INTEGER, event_type TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
CREATE TABLE email_drafts (
        owner_id TEXT NOT NULL, email_id TEXT NOT NULL, version INTEGER NOT NULL,
        payload_json TEXT NOT NULL, recipient TEXT, subject TEXT, body TEXT NOT NULL,
        gmail_account TEXT, review_status TEXT NOT NULL, approval_hash TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, email_id, version)
      );
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE send_attempts (
        idempotency_key TEXT PRIMARY KEY, owner_id TEXT NOT NULL, email_id TEXT NOT NULL,
        draft_version INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        completed_at TEXT, error_code TEXT, error_detail TEXT, provider_message_id TEXT,
        UNIQUE (owner_id, email_id, draft_version, status)
      );
CREATE TABLE sqlite_sequence(name,seq);
