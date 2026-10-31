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
  {
    version: 5,
    statements: [
      // Nachweisdokumentationen (PDF), zentral je Mandant, an Rechnungen anhängbar
      `CREATE TABLE proof_documents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        name VARCHAR(200) NOT NULL,
        filename VARCHAR(200) NOT NULL,
        data LONGBLOB NOT NULL,
        size INT NOT NULL,
        pages INT NOT NULL,
        pdfa_ok TINYINT(1) NOT NULL DEFAULT 1,
        archived TINYINT(1) NOT NULL DEFAULT 0,
        created_by INT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        KEY proofs_tenant (tenant_id, archived),
        CONSTRAINT proofs_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT proofs_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      ) ${TABLE}`,
      `CREATE TABLE document_proofs (
        document_id INT NOT NULL,
        proof_id INT NOT NULL,
        \`position\` INT NOT NULL DEFAULT 0,
        PRIMARY KEY (document_id, proof_id),
        KEY document_proofs_proof (proof_id),
        CONSTRAINT document_proofs_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        CONSTRAINT document_proofs_proof FOREIGN KEY (proof_id) REFERENCES proof_documents(id)
      ) ${TABLE}`,
      `CREATE TRIGGER document_proofs_immutable_delete BEFORE DELETE ON document_proofs FOR EACH ROW
       IF (SELECT finalized_at FROM documents WHERE id = OLD.document_id) IS NOT NULL
       THEN ${forbid('Festgeschriebene Rechnungen koennen nicht geaendert werden')}; END IF`,
      `CREATE TRIGGER document_proofs_immutable_insert BEFORE INSERT ON document_proofs FOR EACH ROW
       IF (SELECT finalized_at FROM documents WHERE id = NEW.document_id) IS NOT NULL
       THEN ${forbid('Festgeschriebene Rechnungen koennen nicht geaendert werden')}; END IF`,
    ],
  },
  {
    version: 6,
    statements: [
      // Nachträgliche Bearbeitung festgeschriebener Rechnungen – jede Fassung bleibt erhalten (GoBD)
      `ALTER TABLE documents ADD COLUMN revision INT NOT NULL DEFAULT 0`,
      `CREATE TABLE document_versions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        document_id INT NOT NULL,
        version INT NOT NULL,
        number VARCHAR(40) NOT NULL,
        status VARCHAR(20) NOT NULL,
        net_total BIGINT NOT NULL,
        tax_total BIGINT NOT NULL,
        gross_total BIGINT NOT NULL,
        snapshot LONGTEXT NOT NULL,
        xml LONGTEXT NULL,
        pdf LONGBLOB NULL,
        finalized_at DATETIME(3) NOT NULL,
        reason TEXT NOT NULL,
        reopened_by INT NULL,
        reopened_by_email VARCHAR(200) NOT NULL DEFAULT '',
        reopened_at DATETIME(3) NOT NULL,
        UNIQUE KEY versions_doc (document_id, version),
        CONSTRAINT versions_document FOREIGN KEY (document_id) REFERENCES documents(id)
      ) ${TABLE}`,
      `CREATE TRIGGER versions_no_update BEFORE UPDATE ON document_versions FOR EACH ROW
       ${forbid('Archivierte Rechnungsversionen koennen nicht geaendert werden')}`,
      `CREATE TRIGGER versions_no_delete BEFORE DELETE ON document_versions FOR EACH ROW
       ${forbid('Archivierte Rechnungsversionen koennen nicht geloescht werden')}`,
      // Die Sperre lässt sich nur über die protokollierte Korrekturfunktion lösen
      // (Sitzungsvariable @schottr_reopen, nur innerhalb dieser einen Transaktion gesetzt).
      `DROP TRIGGER documents_immutable`,
      `CREATE TRIGGER documents_immutable BEFORE UPDATE ON documents FOR EACH ROW
       IF OLD.finalized_at IS NOT NULL AND COALESCE(@schottr_reopen, 0) <> OLD.id AND (
         ${['number', 'contact_id', 'issue_date', 'net_total', 'tax_total', 'gross_total', 'prepaid_total', 'skonto_percent', 'skonto_days', 'snapshot', 'xml', 'pdf', 'finalized_at', 'type_code', 'tax_mode'].map(changed).join(' OR ')}
       ) THEN ${forbid('Festgeschriebene Rechnungen koennen nicht geaendert werden')}; END IF`,
    ],
  },
  {
    version: 7,
    statements: [
      // Adressen haben eine Art: Kunde, Lieferant oder beides
      `ALTER TABLE contacts
        ADD COLUMN kind ENUM('customer', 'supplier', 'both') NOT NULL DEFAULT 'customer' AFTER tenant_id,
        ADD COLUMN expense_category VARCHAR(20) NOT NULL DEFAULT '',
        ADD KEY contacts_kind (tenant_id, kind, archived)`,
      `ALTER TABLE tenants
        ADD COLUMN supplier_number_format VARCHAR(40) NOT NULL DEFAULT 'L{NNNNN}',
        ADD COLUMN datev_creditor_mode ENUM('collective', 'individual') NOT NULL DEFAULT 'collective',
        ADD COLUMN datev_creditor_account INT NOT NULL DEFAULT 70000,
        ADD COLUMN datev_expense_accounts VARCHAR(400) NOT NULL DEFAULT ''`,

      // Nachweise liegen künftig als Datei unter data/nachweise/<Mandant>/ (Inhalt wird beim Start verschoben)
      `ALTER TABLE proof_documents
        MODIFY data LONGBLOB NULL,
        ADD COLUMN path VARCHAR(300) NULL AFTER filename,
        ADD COLUMN sha256 CHAR(64) NOT NULL DEFAULT '' AFTER path`,

      // Eingangsrechnungen (Verbindlichkeiten). Datei unter data/verbindlichkeiten/<Mandant>/
      `CREATE TABLE purchase_invoices (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        contact_id INT NULL,
        status ENUM('draft', 'open', 'paid') NOT NULL DEFAULT 'draft',
        is_credit TINYINT(1) NOT NULL DEFAULT 0,
        number VARCHAR(100) NOT NULL DEFAULT '',
        issue_date DATE NULL,
        due_date DATE NULL,
        service_date DATE NULL,
        description VARCHAR(300) NOT NULL DEFAULT '',
        category VARCHAR(20) NOT NULL DEFAULT 'sonstiges',
        currency CHAR(3) NOT NULL DEFAULT 'EUR',
        net_total BIGINT NOT NULL DEFAULT 0,
        tax_total BIGINT NOT NULL DEFAULT 0,
        gross_total BIGINT NOT NULL DEFAULT 0,
        prepaid_total BIGINT NOT NULL DEFAULT 0,
        paid_at DATE NULL,
        iban VARCHAR(40) NOT NULL DEFAULT '',
        payment_reference VARCHAR(140) NOT NULL DEFAULT '',
        einvoice_format VARCHAR(30) NOT NULL DEFAULT '',
        einvoice_data LONGTEXT NULL,
        file_name VARCHAR(200) NOT NULL DEFAULT '',
        file_path VARCHAR(300) NOT NULL DEFAULT '',
        file_mime VARCHAR(60) NOT NULL DEFAULT '',
        file_size INT NOT NULL DEFAULT 0,
        file_sha256 CHAR(64) NOT NULL DEFAULT '',
        created_by INT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        KEY purchases_tenant (tenant_id, status, due_date),
        KEY purchases_date (tenant_id, issue_date),
        KEY purchases_contact (contact_id),
        KEY purchases_sha (tenant_id, file_sha256),
        CONSTRAINT purchases_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT purchases_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
        CONSTRAINT purchases_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      ) ${TABLE}`,
      // Beträge je Steuersatz (BG-23 der E-Rechnung bzw. manuell erfasst)
      `CREATE TABLE purchase_invoice_taxes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        purchase_id INT NOT NULL,
        \`position\` INT NOT NULL,
        category VARCHAR(2) NOT NULL DEFAULT 'S',
        rate INT NOT NULL,
        basis BIGINT NOT NULL,
        tax BIGINT NOT NULL,
        KEY purchase_taxes_doc (purchase_id, \`position\`),
        CONSTRAINT purchase_taxes_doc FOREIGN KEY (purchase_id) REFERENCES purchase_invoices(id) ON DELETE CASCADE
      ) ${TABLE}`,
    ],
  },
  {
    version: 8,
    statements: [
      // Vereine und gemeinnützige Körperschaften (§§ 51 ff. AO)
      `ALTER TABLE tenants
        ADD COLUMN org_type ENUM('company', 'association') NOT NULL DEFAULT 'company' AFTER small_business,
        ADD COLUMN nonprofit TINYINT(1) NOT NULL DEFAULT 0 AFTER org_type,
        ADD COLUMN default_sphere VARCHAR(10) NOT NULL DEFAULT 'business' AFTER nonprofit`,
      // Tätigkeitsbereich einer Rechnung (ideell, asset, purpose, sport, business) – nur bei gemeinnützigen
      // Mandanten gepflegt; leer = Vorgabe des Mandanten. Interne Zuordnung, darf auch nach dem
      // Festschreiben geändert werden (steht nicht auf dem Beleg, daher nicht im Sperr-Trigger).
      `ALTER TABLE documents ADD COLUMN sphere VARCHAR(10) NOT NULL DEFAULT '' AFTER exemption_reason`,
    ],
  },
  {
    version: 9,
    statements: [
      // Angaben für Zuwendungsbestätigungen (amtliches Muster, BMF-Schreiben vom 7.11.2013)
      `ALTER TABLE tenants
        ADD COLUMN npo_purposes VARCHAR(500) NOT NULL DEFAULT '' AFTER default_sphere,
        ADD COLUMN npo_notice ENUM('exemption', 'assessment') NOT NULL DEFAULT 'exemption' AFTER npo_purposes,
        ADD COLUMN npo_tax_office VARCHAR(100) NOT NULL DEFAULT '' AFTER npo_notice,
        ADD COLUMN npo_notice_date DATE NULL AFTER npo_tax_office,
        ADD COLUMN npo_notice_period VARCHAR(40) NOT NULL DEFAULT '' AFTER npo_notice_date,
        ADD COLUMN npo_membership_deductible TINYINT(1) NOT NULL DEFAULT 1 AFTER npo_notice_period,
        ADD COLUMN npo_signer VARCHAR(200) NOT NULL DEFAULT '' AFTER npo_membership_deductible,
        ADD COLUMN donation_receipt_number_format VARCHAR(40) NOT NULL DEFAULT 'ZB-{YYYY}-{NNNN}' AFTER npo_signer`,

      // Ausgestellte Zuwendungsbestätigungen – das Doppel (§ 50 Abs. 7 EStDV) bleibt als PDF erhalten
      `CREATE TABLE donation_receipts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        contact_id INT NOT NULL,
        number VARCHAR(40) NOT NULL,
        kind ENUM('single', 'collective', 'goods') NOT NULL,
        issue_date DATE NOT NULL,
        period_from DATE NOT NULL,
        period_to DATE NOT NULL,
        total BIGINT NOT NULL,
        status ENUM('issued', 'cancelled') NOT NULL DEFAULT 'issued',
        cancelled_at DATETIME(3) NULL,
        cancel_reason VARCHAR(300) NOT NULL DEFAULT '',
        snapshot LONGTEXT NOT NULL,
        pdf LONGBLOB NOT NULL,
        created_by INT NULL,
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY receipts_number (tenant_id, number),
        KEY receipts_date (tenant_id, issue_date),
        KEY receipts_contact (contact_id),
        CONSTRAINT receipts_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT receipts_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
        CONSTRAINT receipts_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      ) ${TABLE}`,
      // Inhalt und Nummer einer Bestätigung sind unveränderlich, nur der Status darf auf „storniert“ wechseln
      `CREATE TRIGGER receipts_immutable BEFORE UPDATE ON donation_receipts FOR EACH ROW
       IF ${['number', 'contact_id', 'kind', 'issue_date', 'period_from', 'period_to', 'total', 'snapshot', 'pdf'].map(changed).join(' OR ')}
         OR (OLD.status = 'cancelled' AND NEW.status <> 'cancelled')
       THEN ${forbid('Zuwendungsbestaetigungen koennen nicht geaendert werden')}; END IF`,
      `CREATE TRIGGER receipts_no_delete BEFORE DELETE ON donation_receipts FOR EACH ROW
       ${forbid('Zuwendungsbestaetigungen koennen nicht geloescht werden')}`,

      // Zuwendungen: Geldspenden, Mitgliedsbeiträge und Sachspenden (ideeller Bereich)
      `CREATE TABLE donations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        contact_id INT NOT NULL,
        kind ENUM('money', 'membership', 'goods') NOT NULL DEFAULT 'money',
        donation_date DATE NOT NULL,
        amount BIGINT NOT NULL,
        waiver TINYINT(1) NOT NULL DEFAULT 0,
        description VARCHAR(1000) NOT NULL DEFAULT '',
        goods_origin ENUM('', 'business', 'private', 'unknown') NOT NULL DEFAULT '',
        goods_documents TINYINT(1) NOT NULL DEFAULT 0,
        note VARCHAR(300) NOT NULL DEFAULT '',
        receipt_id INT NULL,
        created_by INT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        KEY donations_date (tenant_id, donation_date),
        KEY donations_contact (contact_id),
        KEY donations_receipt (receipt_id),
        CONSTRAINT donations_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT donations_contact FOREIGN KEY (contact_id) REFERENCES contacts(id),
        CONSTRAINT donations_receipt FOREIGN KEY (receipt_id) REFERENCES donation_receipts(id),
        CONSTRAINT donations_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      ) ${TABLE}`,
      // Bestätigte Zuwendungen sind gesperrt – erst nach Storno der Bestätigung wieder änderbar
      `CREATE TRIGGER donations_locked BEFORE UPDATE ON donations FOR EACH ROW
       IF OLD.receipt_id IS NOT NULL AND NEW.receipt_id <=> OLD.receipt_id AND (
         ${['contact_id', 'kind', 'donation_date', 'amount', 'waiver', 'description', 'goods_origin', 'goods_documents'].map(changed).join(' OR ')}
       ) THEN ${forbid('Bestaetigte Zuwendungen koennen nicht geaendert werden')}; END IF`,
      `CREATE TRIGGER donations_no_delete BEFORE DELETE ON donations FOR EACH ROW
       IF OLD.receipt_id IS NOT NULL THEN ${forbid('Bestaetigte Zuwendungen koennen nicht geloescht werden')}; END IF`,
    ],
  },
  {
    version: 10,
    statements: [
      // Kassenbuch: Abschluss bis zu einem Datum (danach keine Änderungen mehr)
      `ALTER TABLE tenants ADD COLUMN cashbook_locked_until DATE NULL AFTER donation_receipt_number_format`,
      // Eingangsrechnungen bekommen wie Ausgangsrechnungen einen Tätigkeitsbereich (gemeinnützige Vereine)
      `ALTER TABLE purchase_invoices ADD COLUMN sphere VARCHAR(10) NOT NULL DEFAULT '' AFTER category`,

      // Konten: Bankkonten und Bargeldkassen mit Anfangsbestand
      `CREATE TABLE cash_accounts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        name VARCHAR(100) NOT NULL,
        kind ENUM('bank', 'cash') NOT NULL DEFAULT 'bank',
        iban VARCHAR(40) NOT NULL DEFAULT '',
        opening_date DATE NOT NULL,
        opening_balance BIGINT NOT NULL DEFAULT 0,
        archived TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL,
        KEY cash_accounts_tenant (tenant_id, archived),
        CONSTRAINT cash_accounts_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ${TABLE}`,

      // Geldzählungen einer Kasse (Stückelung als JSON); die Differenz zum Buchbestand wird gebucht
      `CREATE TABLE cash_counts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        account_id INT NOT NULL,
        count_date DATE NOT NULL,
        counted BIGINT NOT NULL,
        denominations VARCHAR(1000) NOT NULL DEFAULT '{}',
        book_balance BIGINT NOT NULL,
        difference BIGINT NOT NULL,
        note VARCHAR(300) NOT NULL DEFAULT '',
        created_by INT NULL,
        created_at DATETIME(3) NOT NULL,
        KEY cash_counts_account (account_id, count_date),
        CONSTRAINT cash_counts_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT cash_counts_account FOREIGN KEY (account_id) REFERENCES cash_accounts(id),
        CONSTRAINT cash_counts_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      ) ${TABLE}`,

      // Buchungen: Betrag mit Vorzeichen (+ Einnahme, − Ausgabe). Verknüpft mit genau einer Quelle
      // (Rechnung, Eingangsrechnung, Spende, Umbuchung, Geldzählung) oder frei erfasst.
      `CREATE TABLE cash_entries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        account_id INT NOT NULL,
        entry_date DATE NOT NULL,
        amount BIGINT NOT NULL,
        source ENUM('manual', 'invoice', 'purchase', 'donation', 'transfer', 'count') NOT NULL DEFAULT 'manual',
        document_id INT NULL,
        purchase_id INT NULL,
        donation_id INT NULL,
        count_id INT NULL,
        transfer_group CHAR(16) NULL,
        text VARCHAR(300) NOT NULL DEFAULT '',
        receipt_ref VARCHAR(100) NOT NULL DEFAULT '',
        sphere VARCHAR(10) NOT NULL DEFAULT '',
        vat_rate INT NOT NULL DEFAULT 0,
        created_by INT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY cash_entries_document (document_id),
        UNIQUE KEY cash_entries_purchase (purchase_id),
        UNIQUE KEY cash_entries_donation (donation_id),
        UNIQUE KEY cash_entries_count (count_id),
        KEY cash_entries_account (account_id, entry_date, id),
        KEY cash_entries_tenant (tenant_id, entry_date),
        KEY cash_entries_transfer (transfer_group),
        CONSTRAINT cash_entries_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT cash_entries_account FOREIGN KEY (account_id) REFERENCES cash_accounts(id),
        CONSTRAINT cash_entries_document FOREIGN KEY (document_id) REFERENCES documents(id),
        CONSTRAINT cash_entries_purchase FOREIGN KEY (purchase_id) REFERENCES purchase_invoices(id),
        CONSTRAINT cash_entries_donation FOREIGN KEY (donation_id) REFERENCES donations(id),
        CONSTRAINT cash_entries_count FOREIGN KEY (count_id) REFERENCES cash_counts(id),
        CONSTRAINT cash_entries_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      ) ${TABLE}`,

      // Abgeschlossene Zeiträume sind gesperrt – auch direkt in der Datenbank
      `CREATE TRIGGER cash_entries_lock_ins BEFORE INSERT ON cash_entries FOR EACH ROW
       IF NEW.entry_date <= COALESCE((SELECT cashbook_locked_until FROM tenants WHERE id = NEW.tenant_id), '0000-01-01') THEN ${forbid('Das Kassenbuch ist fuer diesen Zeitraum abgeschlossen')}; END IF`,
      `CREATE TRIGGER cash_entries_lock_upd BEFORE UPDATE ON cash_entries FOR EACH ROW
       IF OLD.entry_date <= COALESCE((SELECT cashbook_locked_until FROM tenants WHERE id = OLD.tenant_id), '0000-01-01') OR NEW.entry_date <= COALESCE((SELECT cashbook_locked_until FROM tenants WHERE id = NEW.tenant_id), '0000-01-01') THEN ${forbid('Das Kassenbuch ist fuer diesen Zeitraum abgeschlossen')}; END IF`,
      `CREATE TRIGGER cash_entries_lock_del BEFORE DELETE ON cash_entries FOR EACH ROW
       IF OLD.entry_date <= COALESCE((SELECT cashbook_locked_until FROM tenants WHERE id = OLD.tenant_id), '0000-01-01') THEN ${forbid('Das Kassenbuch ist fuer diesen Zeitraum abgeschlossen')}; END IF`,
      `CREATE TRIGGER cash_counts_lock_ins BEFORE INSERT ON cash_counts FOR EACH ROW
       IF NEW.count_date <= COALESCE((SELECT cashbook_locked_until FROM tenants WHERE id = NEW.tenant_id), '0000-01-01') THEN ${forbid('Das Kassenbuch ist fuer diesen Zeitraum abgeschlossen')}; END IF`,
      `CREATE TRIGGER cash_counts_lock_del BEFORE DELETE ON cash_counts FOR EACH ROW
       IF OLD.count_date <= COALESCE((SELECT cashbook_locked_until FROM tenants WHERE id = OLD.tenant_id), '0000-01-01') THEN ${forbid('Das Kassenbuch ist fuer diesen Zeitraum abgeschlossen')}; END IF`,
    ],
  },
  {
    version: 11,
    statements: [
      // Daueraufträge (z. B. Miete, Kontoführung, Versicherung): wiederkehrende Buchungen, die
      // zum Termin in der Übersicht zum Buchen angeboten werden
      `CREATE TABLE cash_recurring (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        account_id INT NOT NULL,
        amount BIGINT NOT NULL,
        rhythm ENUM('monthly', 'quarterly', 'halfyearly', 'yearly') NOT NULL DEFAULT 'monthly',
        start_date DATE NOT NULL,
        end_date DATE NULL,
        text VARCHAR(300) NOT NULL,
        receipt_ref VARCHAR(100) NOT NULL DEFAULT '',
        category VARCHAR(20) NOT NULL DEFAULT '',
        sphere VARCHAR(10) NOT NULL DEFAULT '',
        vat_rate INT NOT NULL DEFAULT 0,
        active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        KEY recurring_tenant (tenant_id, active),
        CONSTRAINT recurring_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT recurring_account FOREIGN KEY (account_id) REFERENCES cash_accounts(id),
        CONSTRAINT recurring_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      ) ${TABLE}`,
      // bewusst ausgelassene Termine (z. B. Miete im Sommer erlassen)
      `CREATE TABLE cash_recurring_skips (
        recurring_id INT NOT NULL,
        due_date DATE NOT NULL,
        created_at DATETIME(3) NOT NULL,
        PRIMARY KEY (recurring_id, due_date),
        CONSTRAINT recurring_skips FOREIGN KEY (recurring_id) REFERENCES cash_recurring(id) ON DELETE CASCADE
      ) ${TABLE}`,
      // Buchungen: Kostenart (freie Buchungen) und Herkunft aus einem Dauerauftrag (je Termin höchstens einmal)
      `ALTER TABLE cash_entries
        ADD COLUMN category VARCHAR(20) NOT NULL DEFAULT '' AFTER sphere,
        ADD COLUMN recurring_id INT NULL AFTER count_id,
        ADD COLUMN recurring_due DATE NULL AFTER recurring_id,
        ADD UNIQUE KEY cash_entries_recurring (recurring_id, recurring_due),
        ADD CONSTRAINT cash_entries_recurring FOREIGN KEY (recurring_id) REFERENCES cash_recurring(id) ON DELETE SET NULL`,
    ],
  },
  {
    version: 12,
    statements: [
      // Belege zu Kassenbuch-Buchungen (PDF oder Foto, z. B. Quittung) – Datei in der Belegablage
      // (data/verbindlichkeiten/<Mandant>/kasse_…), hier nur Verweis und Prüfsumme
      `CREATE TABLE cash_entry_files (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        entry_id INT NOT NULL,
        file_name VARCHAR(200) NOT NULL,
        file_path VARCHAR(300) NOT NULL,
        file_mime VARCHAR(60) NOT NULL,
        file_size INT NOT NULL,
        file_sha256 CHAR(64) NOT NULL,
        created_by INT NULL,
        created_at DATETIME(3) NOT NULL,
        KEY cash_files_entry (entry_id),
        CONSTRAINT cash_files_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT cash_files_entry FOREIGN KEY (entry_id) REFERENCES cash_entries(id),
        CONSTRAINT cash_files_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      ) ${TABLE}`,
    ],
  },
  {
    version: 13,
    statements: [
      // Belegeingang: hochgeladene, noch keiner Eingangsrechnung oder Buchung zugeordnete Belege
      // (Datei unter data/other/<Mandant>/ – beim Zuordnen wird sie verschoben und der Eintrag gelöscht)
      `CREATE TABLE inbox_files (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        file_name VARCHAR(200) NOT NULL,
        file_path VARCHAR(300) NOT NULL,
        file_mime VARCHAR(60) NOT NULL,
        file_size INT NOT NULL,
        file_sha256 CHAR(64) NOT NULL,
        note VARCHAR(300) NOT NULL DEFAULT '',
        created_by INT NULL,
        created_at DATETIME(3) NOT NULL,
        KEY inbox_tenant (tenant_id, created_at),
        CONSTRAINT inbox_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT inbox_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      ) ${TABLE}`,
    ],
  },
  {
    version: 14,
    statements: [
      // Datum einer Kassenzählung ist änderbar – abgeschlossene Zeiträume bleiben auch hier gesperrt
      `CREATE TRIGGER cash_counts_lock_upd BEFORE UPDATE ON cash_counts FOR EACH ROW
       IF OLD.count_date <= COALESCE((SELECT cashbook_locked_until FROM tenants WHERE id = OLD.tenant_id), '0000-01-01') OR NEW.count_date <= COALESCE((SELECT cashbook_locked_until FROM tenants WHERE id = NEW.tenant_id), '0000-01-01') THEN ${forbid('Das Kassenbuch ist fuer diesen Zeitraum abgeschlossen')}; END IF`,
    ],
  },
];
