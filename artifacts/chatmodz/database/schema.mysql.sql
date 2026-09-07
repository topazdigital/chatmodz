-- Chatmodz owns this database.
-- Run this script against a dedicated MySQL 8 database before enabling live adapters.
-- Secrets (adapter signing keys and operator activation codes) are stored as hashes.

CREATE TABLE IF NOT EXISTS sites (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  internal_name VARCHAR(120) NOT NULL,
  display_name VARCHAR(160) NOT NULL,
  status ENUM('active', 'paused', 'disconnected') NOT NULL DEFAULT 'active',
  integration_type ENUM('webhook', 'api', 'hybrid') NOT NULL,
  signing_secret_hash CHAR(64) NULL,
  secret_env_key VARCHAR(160) NULL,
  endpoint_base_url VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  member_photo_url VARCHAR(500) NULL,
  managed_profile_photo_url VARCHAR(500) NULL,
  lock_expires_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  UNIQUE KEY sites_internal_name_unique (internal_name),
  KEY sites_status_idx (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS operators (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id CHAR(26) NOT NULL,
  full_name VARCHAR(160) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('operator', 'admin') NOT NULL DEFAULT 'operator',
  status ENUM('pending', 'training', 'active', 'suspended', 'rejected') NOT NULL DEFAULT 'pending',
  last_active_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY operators_public_id_unique (public_id),
  UNIQUE KEY operators_email_unique (email),
  KEY operators_status_idx (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS operator_applications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  full_name VARCHAR(160) NOT NULL,
  email VARCHAR(255) NOT NULL,
  location VARCHAR(160) NULL,
  experience TEXT NULL,
  status ENUM('pending', 'approved', 'training', 'active', 'rejected') NOT NULL DEFAULT 'pending',
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY applications_status_created_idx (status, created_at),
  CONSTRAINT applications_reviewed_by_fk FOREIGN KEY (reviewed_by) REFERENCES operators (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS operator_activation_codes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operator_id BIGINT UNSIGNED NOT NULL,
  code_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL,
  revoked_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY activation_code_hash_unique (code_hash),
  KEY activation_operator_idx (operator_id),
  CONSTRAINT activation_operator_fk FOREIGN KEY (operator_id) REFERENCES operators (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id BIGINT UNSIGNED NOT NULL,
  external_conversation_id VARCHAR(255) NOT NULL,
  member_alias VARCHAR(160) NOT NULL,
  managed_profile_alias VARCHAR(160) NOT NULL,
  managed_profile_external_id VARCHAR(255) NULL,
  priority ENUM('normal', 'high', 'urgent') NOT NULL DEFAULT 'normal',
  status ENUM('open', 'waiting', 'closed') NOT NULL DEFAULT 'open',
  assigned_operator_id BIGINT UNSIGNED NULL,
  last_message_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY conversation_external_unique (site_id, external_conversation_id),
  KEY conversations_queue_idx (status, assigned_operator_id, last_message_at),
  CONSTRAINT conversations_site_fk FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE RESTRICT,
  CONSTRAINT conversations_operator_fk FOREIGN KEY (assigned_operator_id) REFERENCES operators (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversation_assignments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id BIGINT UNSIGNED NOT NULL,
  operator_id BIGINT UNSIGNED NOT NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  KEY assignments_active_idx (conversation_id, released_at),
  CONSTRAINT assignments_conversation_fk FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT assignments_operator_fk FOREIGN KEY (operator_id) REFERENCES operators (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id BIGINT UNSIGNED NOT NULL,
  external_message_id VARCHAR(255) NULL,
  sender_type ENUM('member', 'managed_profile', 'system') NOT NULL,
  body TEXT NOT NULL,
  media_proxy_url VARCHAR(500) NULL,
  media_type VARCHAR(40) NULL,
  delivery_status ENUM('received', 'queued', 'delivered', 'failed') NOT NULL DEFAULT 'received',
  sent_by_operator_id BIGINT UNSIGNED NULL,
  sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY messages_external_unique (conversation_id, external_message_id),
  KEY messages_conversation_sent_idx (conversation_id, sent_at),
  CONSTRAINT messages_conversation_fk FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT messages_operator_fk FOREIGN KEY (sent_by_operator_id) REFERENCES operators (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS operator_push_subscriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operator_id BIGINT UNSIGNED NOT NULL,
  endpoint VARCHAR(1000) NOT NULL,
  p256dh VARCHAR(255) NOT NULL,
  auth_key VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY push_endpoint_unique (endpoint(255)),
  KEY push_operator_idx (operator_id),
  CONSTRAINT push_operator_fk FOREIGN KEY (operator_id) REFERENCES operators (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS integration_deliveries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id BIGINT UNSIGNED NOT NULL,
  direction ENUM('incoming', 'outgoing') NOT NULL,
  external_event_id VARCHAR(255) NOT NULL,
  conversation_id BIGINT UNSIGNED NULL,
  status ENUM('received', 'processed', 'delivered', 'failed') NOT NULL DEFAULT 'received',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  error_message VARCHAR(500) NULL,
  payload_json JSON NULL,
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  UNIQUE KEY deliveries_event_unique (site_id, direction, external_event_id),
  KEY deliveries_status_received_idx (status, received_at),
  CONSTRAINT deliveries_site_fk FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE CASCADE,
  CONSTRAINT deliveries_conversation_fk FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS operator_activity (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operator_id BIGINT UNSIGNED NOT NULL,
  activity_type ENUM('login', 'claim', 'release', 'reply', 'logout', 'training') NOT NULL,
  conversation_id BIGINT UNSIGNED NULL,
  site_id BIGINT UNSIGNED NULL,
  metadata_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY activity_operator_created_idx (operator_id, created_at),
  KEY activity_site_created_idx (site_id, created_at),
  CONSTRAINT activity_operator_fk FOREIGN KEY (operator_id) REFERENCES operators (id) ON DELETE CASCADE,
  CONSTRAINT activity_conversation_fk FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE SET NULL,
  CONSTRAINT activity_site_fk FOREIGN KEY (site_id) REFERENCES sites (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_operator_id BIGINT UNSIGNED NULL,
  action VARCHAR(120) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id BIGINT UNSIGNED NULL,
  ip_address VARBINARY(16) NULL,
  metadata_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY audit_actor_created_idx (actor_operator_id, created_at),
  KEY audit_entity_idx (entity_type, entity_id),
  CONSTRAINT audit_actor_fk FOREIGN KEY (actor_operator_id) REFERENCES operators (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;