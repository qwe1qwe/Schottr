/**
 * Schema-Migrationen (MariaDB ≥ 10.11). Neue Module hängen einfach weitere Einträge an
 * (Versionsnummer immer höher als die letzte). Jede Anweisung steht einzeln, weil
 * DDL in MariaDB nicht transaktional ist.
 *
 * Geldbeträge: BIGINT in Cent. Mengen: BIGINT in Tausendstel (1,5 Std. = 1500).
 * Steuersätze: INT in Basispunkten (19 % = 1900). Zeitstempel: DATETIME(3) in UTC.
 */
const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

/** Trigger, der bei festgeschriebenen Rechnungen abbricht. */
const forbid = (msg: string) => `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${msg}'`;
const changed = (col: string) => `NOT (NEW.${col} <=> OLD.${col})`;

export const migrations: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE tenants (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        contact_name VARCHAR(200) NOT NULL DEFAULT '',
        street VARCHAR(200) NOT NULL DEFAULT '',
        zip VARCHAR(10) NOT NULL DEFAULT '',
        city VARCHAR(100) NOT NULL DEFAULT '',
        country CHAR(2) NOT NULL DEFAULT 'DE',
        email VARCHAR(200) NOT NULL DEFAULT '',
        phone VARCHAR(50) NOT NULL DEFAULT '',
        website VARCHAR(200) NOT NULL DEFAULT '',
        vat_id VARCHAR(20) NOT NULL DEFAULT '',
        tax_number VARCHAR(30) NOT NULL DEFAULT '',
        register_court VARCHAR(100) NOT NULL DEFAULT '',
        register_number VARCHAR(50) NOT NULL DEFAULT '',
        managing_directors VARCHAR(200) NOT NULL DEFAULT '',
        bank_name VARCHAR(100) NOT NULL DEFAULT '',
        iban VARCHAR(40) NOT NULL DEFAULT '',
        bic VARCHAR(11) NOT NULL DEFAULT '',
        small_business TINYINT(1) NOT NULL DEFAULT 0,
        payment_days INT NOT NULL DEFAULT 14,
        quote_valid_days INT NOT NULL DEFAULT 30,
        quote_number_format VARCHAR(40) NOT NULL DEFAULT 'AN-{YYYY}-{NNNN}',
        invoice_number_format VARCHAR(40) NOT NULL DEFAULT 'RE-{YYYY}-{NNNN}',
        customer_number_format VARCHAR(40) NOT NULL DEFAULT 'K{NNNNN}',
        quote_intro TEXT NOT NULL DEFAULT 'vielen Dank für Ihre Anfrage. Gerne unterbreiten wir Ihnen folgendes Angebot:',
        quote_outro TEXT NOT NULL DEFAULT 'Wir freuen uns auf Ihren Auftrag.',
        invoice_intro TEXT NOT NULL DEFAULT 'vielen Dank für Ihren Auftrag. Wir berechnen Ihnen folgende Leistungen:',
        invoice_outro TEXT NOT NULL DEFAULT '',
        created_at DATETIME(3) NOT NULL
      ) ${TABLE}`,

      `CREATE TABLE users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(200) NOT NULL,
        name VARCHAR(200) NOT NULL DEFAULT '',
        password_hash VARCHAR(255) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY users_email (email)
      ) ${TABLE}`,

      `CREATE TABLE memberships (
        user_id INT NOT NULL,
        tenant_id INT NOT NULL,
        role ENUM('owner', 'member') NOT NULL DEFAULT 'member',
        PRIMARY KEY (user_id, tenant_id),
        CONSTRAINT memberships_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT memberships_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ${TABLE}`,

      `CREATE TABLE sessions (
        id CHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        tenant_id INT NULL,
        csrf VARCHAR(64) NOT NULL,
        expires_at DATETIME(3) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        KEY sessions_expires (expires_at),
        CONSTRAINT sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT sessions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
      ) ${TABLE}`,

      `CREATE TABLE counters (
        tenant_id INT NOT NULL,
        kind VARCHAR(20) NOT NULL,
        period VARCHAR(10) NOT NULL,
        \`value\` INT NOT NULL,
        PRIMARY KEY (tenant_id, kind, period),
        CONSTRAINT counters_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ${TABLE}`,

      `CREATE TABLE contacts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        customer_number VARCHAR(40) NOT NULL,
        company VARCHAR(200) NOT NULL DEFAULT '',
        name VARCHAR(200) NOT NULL DEFAULT '',
        street VARCHAR(200) NOT NULL DEFAULT '',
        address_extra VARCHAR(200) NOT NULL DEFAULT '',
        zip VARCHAR(10) NOT NULL DEFAULT '',
        city VARCHAR(100) NOT NULL DEFAULT '',
        country CHAR(2) NOT NULL DEFAULT 'DE',
        email VARCHAR(200) NOT NULL DEFAULT '',
        phone VARCHAR(50) NOT NULL DEFAULT '',
        vat_id VARCHAR(20) NOT NULL DEFAULT '',
        leitweg_id VARCHAR(50) NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        archived TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY contacts_number (tenant_id, customer_number),
        KEY contacts_tenant (tenant_id, archived),
        CONSTRAINT contacts_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ${TABLE}`,

      `CREATE TABLE documents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        kind ENUM('quote', 'invoice') NOT NULL,
        type_code CHAR(3) NOT NULL DEFAULT '380',
        number VARCHAR(40) NULL,
        status VARCHAR(20) NOT NULL,
        contact_id INT NOT NULL,
        issue_date DATE NOT NULL,
        valid_until DATE NULL,
        due_date DATE NULL,
        service_date DATE NULL,
        service_from DATE NULL,
        service_to DATE NULL,
        subject VARCHAR(200) NOT NULL DEFAULT '',
        intro TEXT NOT NULL DEFAULT '',
        outro TEXT NOT NULL DEFAULT '',
        buyer_reference VARCHAR(100) NOT NULL DEFAULT '',
        order_reference VARCHAR(100) NOT NULL DEFAULT '',
        tax_mode ENUM('standard', 'small_business', 'reverse_charge', 'exempt') NOT NULL DEFAULT 'standard',
        exemption_reason VARCHAR(300) NOT NULL DEFAULT '',
        currency CHAR(3) NOT NULL DEFAULT 'EUR',
        net_total BIGINT NOT NULL DEFAULT 0,
        tax_total BIGINT NOT NULL DEFAULT 0,
        gross_total BIGINT NOT NULL DEFAULT 0,
        source_quote_id INT NULL,
        corrects_id INT NULL,
        snapshot LONGTEXT NULL,
        xml LONGTEXT NULL,
        pdf LONGBLOB NULL,
        finalized_at DATETIME(3) NULL,
        paid_at DATE NULL,
        created_by INT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY documents_number (tenant_id, kind, number),
        KEY documents_tenant (tenant_id, kind, status),
        KEY documents_contact (contact_id),
        CONSTRAINT documents_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT documents_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
        CONSTRAINT documents_quote FOREIGN KEY (source_quote_id) REFERENCES documents(id) ON DELETE SET NULL,
        CONSTRAINT documents_corrects FOREIGN KEY (corrects_id) REFERENCES documents(id),
        CONSTRAINT documents_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      ) ${TABLE}`,

      `CREATE TABLE document_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        document_id INT NOT NULL,
        \`position\` INT NOT NULL,
        title VARCHAR(300) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        quantity BIGINT NOT NULL,
        unit VARCHAR(3) NOT NULL DEFAULT 'C62',
        unit_price BIGINT NOT NULL,
        vat_rate INT NOT NULL,
        line_total BIGINT NOT NULL,
        KEY document_items_doc (document_id, \`position\`),
        CONSTRAINT items_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      ) ${TABLE}`,

      // GoBD: festgeschriebene Rechnungen sind unveränderbar und nicht löschbar.
      `CREATE TRIGGER documents_immutable BEFORE UPDATE ON documents FOR EACH ROW
       IF OLD.finalized_at IS NOT NULL AND (
         ${['number', 'contact_id', 'issue_date', 'net_total', 'tax_total', 'gross_total', 'snapshot', 'xml', 'pdf', 'finalized_at', 'type_code', 'tax_mode'].map(changed).join(' OR ')}
       ) THEN ${forbid('Festgeschriebene Rechnungen koennen nicht geaendert werden')}; END IF`,

      `CREATE TRIGGER documents_no_delete_final BEFORE DELETE ON documents FOR EACH ROW
       IF OLD.finalized_at IS NOT NULL THEN ${forbid('Festgeschriebene Rechnungen koennen nicht geloescht werden')}; END IF`,

      `CREATE TRIGGER items_immutable_update BEFORE UPDATE ON document_items FOR EACH ROW
       IF (SELECT finalized_at FROM documents WHERE id = OLD.document_id) IS NOT NULL
       THEN ${forbid('Positionen festgeschriebener Rechnungen koennen nicht geaendert werden')}; END IF`,

      `CREATE TRIGGER items_immutable_delete BEFORE DELETE ON document_items FOR EACH ROW
       IF (SELECT finalized_at FROM documents WHERE id = OLD.document_id) IS NOT NULL
       THEN ${forbid('Positionen festgeschriebener Rechnungen koennen nicht geloescht werden')}; END IF`,

      `CREATE TRIGGER items_immutable_insert BEFORE INSERT ON document_items FOR EACH ROW
       IF (SELECT finalized_at FROM documents WHERE id = NEW.document_id) IS NOT NULL
       THEN ${forbid('Festgeschriebene Rechnungen koennen nicht ergaenzt werden')}; END IF`,
    ],
  },
  {
    version: 2,
    statements: [
      // Artikelstamm (optional – Freitext-Positionen bleiben möglich)
      `CREATE TABLE articles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        number VARCHAR(40) NOT NULL DEFAULT '',
        title VARCHAR(300) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        unit VARCHAR(3) NOT NULL DEFAULT 'C62',
        unit_price BIGINT NOT NULL DEFAULT 0,
        vat_rate INT NOT NULL DEFAULT 1900,
        archived TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        KEY articles_tenant (tenant_id, archived),
        CONSTRAINT articles_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ${TABLE}`,
      `ALTER TABLE document_items ADD COLUMN article_number VARCHAR(40) NOT NULL DEFAULT '' AFTER \`position\``,

      // Mahnwesen
      `ALTER TABLE tenants
        ADD COLUMN dunning_fee_1 BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN dunning_fee_2 BIGINT NOT NULL DEFAULT 500,
        ADD COLUMN dunning_fee_3 BIGINT NOT NULL DEFAULT 1000,
        ADD COLUMN dunning_deadline_days INT NOT NULL DEFAULT 10,
        ADD COLUMN dunning_interval_days INT NOT NULL DEFAULT 3`,
      `CREATE TABLE dunnings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        invoice_id INT NOT NULL,
        level TINYINT NOT NULL,
        issue_date DATE NOT NULL,
        deadline DATE NOT NULL,
        fee BIGINT NOT NULL DEFAULT 0,
        text TEXT NOT NULL,
        created_by INT NULL,
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY dunnings_level (invoice_id, level),
        KEY dunnings_tenant (tenant_id, issue_date),
        CONSTRAINT dunnings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT dunnings_invoice FOREIGN KEY (invoice_id) REFERENCES documents(id),
        CONSTRAINT dunnings_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      ) ${TABLE}`,

      // Einladungen in Mandanten (portalintern, ohne E-Mail-Versand)
      `CREATE TABLE invitations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        email VARCHAR(200) NOT NULL,
        role ENUM('owner', 'member') NOT NULL DEFAULT 'member',
        status ENUM('pending', 'accepted', 'declined', 'revoked') NOT NULL DEFAULT 'pending',
        invited_by INT NULL,
        created_at DATETIME(3) NOT NULL,
        responded_at DATETIME(3) NULL,
        KEY invitations_email (email, status),
        KEY invitations_tenant (tenant_id, status),
        CONSTRAINT invitations_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT invitations_user FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL
      ) ${TABLE}`,
    ],
  },
  {
    version: 3,
    statements: [
      // Übergreifende Administration
      `ALTER TABLE users
        ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0,
        ADD COLUMN disabled TINYINT(1) NOT NULL DEFAULT 0,
        ADD COLUMN last_login_at DATETIME(3) NULL`,
      // bisher erster Benutzer wird Administrator
      `UPDATE users SET is_admin = 1 ORDER BY id LIMIT 1`,
      `ALTER TABLE tenants ADD COLUMN disabled TINYINT(1) NOT NULL DEFAULT 0`,
      `CREATE TABLE app_settings (
        \`key\` VARCHAR(64) PRIMARY KEY,
        \`value\` TEXT NOT NULL,
        updated_at DATETIME(3) NOT NULL
      ) ${TABLE}`,
      `CREATE TABLE audit_log (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        created_at DATETIME(3) NOT NULL,
        user_id INT NULL,
        user_email VARCHAR(200) NOT NULL DEFAULT '',
        tenant_id INT NULL,
        action VARCHAR(64) NOT NULL,
        details VARCHAR(1000) NOT NULL DEFAULT '',
        ip VARCHAR(64) NOT NULL DEFAULT '',
        KEY audit_created (created_at),
        KEY audit_tenant (tenant_id, created_at),
        KEY audit_action (action, created_at)
      ) ${TABLE}`,
    ],
  },
  {
    version: 4,
    statements: [
      // Logo je Mandant (eigene Tabelle, damit es nicht bei jeder Anfrage mitgeladen wird)
      `CREATE TABLE tenant_logos (
        tenant_id INT PRIMARY KEY,
        data MEDIUMBLOB NOT NULL,
        mime VARCHAR(30) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        CONSTRAINT logos_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ${TABLE}`,

      // Skonto-Vorgabe und DATEV-Einstellungen
      `ALTER TABLE tenants
        ADD COLUMN skonto_percent INT NOT NULL DEFAULT 0,
        ADD COLUMN skonto_days INT NOT NULL DEFAULT 0,
        ADD COLUMN datev_consultant VARCHAR(7) NOT NULL DEFAULT '',
        ADD COLUMN datev_client VARCHAR(5) NOT NULL DEFAULT '',
        ADD COLUMN datev_skr CHAR(2) NOT NULL DEFAULT '03',
        ADD COLUMN datev_account_length TINYINT NOT NULL DEFAULT 4,
        ADD COLUMN datev_debtor_mode ENUM('collective', 'individual') NOT NULL DEFAULT 'collective',
        ADD COLUMN datev_debtor_account INT NOT NULL DEFAULT 10000,
        ADD COLUMN datev_accounts VARCHAR(200) NOT NULL DEFAULT ''`,

      // Skonto, Vorauszahlungen (Teil-/Schlussrechnungen)
      `ALTER TABLE documents
        ADD COLUMN skonto_percent INT NOT NULL DEFAULT 0,
        ADD COLUMN skonto_days INT NOT NULL DEFAULT 0,
        ADD COLUMN prepaid_total BIGINT NOT NULL DEFAULT 0`,
      `CREATE TABLE document_prepayments (
        document_id INT NOT NULL,
        prepaid_id INT NOT NULL,
        PRIMARY KEY (document_id, prepaid_id),
        KEY prepayments_prepaid (prepaid_id),
        CONSTRAINT prepayments_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        CONSTRAINT prepayments_prepaid FOREIGN KEY (prepaid_id) REFERENCES documents(id)
      ) ${TABLE}`,

      // GoBD-Sperre um die neuen Felder erweitern
      `DROP TRIGGER documents_immutable`,
      `CREATE TRIGGER documents_immutable BEFORE UPDATE ON documents FOR EACH ROW
       IF OLD.finalized_at IS NOT NULL AND (
         ${['number', 'contact_id', 'issue_date', 'net_total', 'tax_total', 'gross_total', 'prepaid_total', 'skonto_percent', 'skonto_days', 'snapshot', 'xml', 'pdf', 'finalized_at', 'type_code', 'tax_mode'].map(changed).join(' OR ')}
       ) THEN ${forbid('Festgeschriebene Rechnungen koennen nicht geaendert werden')}; END IF`,
      `CREATE TRIGGER prepayments_immutable_delete BEFORE DELETE ON document_prepayments FOR EACH ROW
       IF (SELECT finalized_at FROM documents WHERE id = OLD.document_id) IS NOT NULL
       THEN ${forbid('Festgeschriebene Rechnungen koennen nicht geaendert werden')}; END IF`,
      `CREATE TRIGGER prepayments_immutable_insert BEFORE INSERT ON document_prepayments FOR EACH ROW
       IF (SELECT finalized_at FROM documents WHERE id = NEW.document_id) IS NOT NULL
       THEN ${forbid('Festgeschriebene Rechnungen koennen nicht geaendert werden')}; END IF`,
    ],
  },
];
