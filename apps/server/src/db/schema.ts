import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  primaryKey,
  index,
} from 'drizzle-orm/sqlite-core';

// 1. 使用者帳號表
export const users = sqliteTable('users', {
  id: text('id').primaryKey(), // UUID
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  avatarUrl: text('avatar_url'),
  serverRole: text('server_role').notNull().default('member'), // 'admin' | 'member'
  isActive: integer('is_active').notNull().default(1),
  guestRemovedAt: integer('guest_removed_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const canvasGroups = sqliteTable('canvas_groups', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  title: text('title').notNull(),
  roomPassHash: text('room_pass_hash'),
});

export const canvasGroupMembers = sqliteTable('canvas_group_members', {
  groupId: text('group_id').notNull().references(() => canvasGroups.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (table) => ({ pk: primaryKey({ columns: [table.groupId, table.userId] }) }));

// 2. 畫布 / 繪茶房間表
export const canvases = sqliteTable('canvases', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => users.id),
  title: text('title').notNull(),
  width: integer('width').notNull().default(2048),
  height: integer('height').notNull().default(2048),
  dpi: integer('dpi').notNull().default(300),
  bgColor: text('bg_color').notNull().default('#FFFFFF'),
  accessMode: text('access_mode').notNull().default('invite'), // 'invite' | 'password' | 'whitelist'
  inviteCode: text('invite_code').unique(),
  roomPassHash: text('room_pass_hash'),
  groupId: text('group_id').references(() => canvasGroups.id),
  latestSeq: integer('latest_seq').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// 3. 畫布成員與房間級權限表 (ACL)
export const canvasMembers = sqliteTable(
  'canvas_members',
  {
    canvasId: text('canvas_id')
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('editor'), // 'owner' | 'admin' | 'editor' | 'viewer'
    canCreateLayer: integer('can_create_layer').notNull().default(1),
    canDeleteOtherLayer: integer('can_delete_other_layer').notNull().default(0),
    canExport: integer('can_export').notNull().default(1),
    canManageMembers: integer('can_manage_members').notNull().default(0),
    joinedAt: integer('joined_at').notNull(),
    lastSeenAt: integer('last_seen_at'), // when their last tab left this canvas
    drawTimeMs: integer('draw_time_ms').notNull().default(0), // continuous drawing time on this canvas
  },
  (table) => ({
    pk: primaryKey({ columns: [table.canvasId, table.userId] }),
  })
);

// 4. 圖層與資料夾結構表
export const layers = sqliteTable(
  'layers',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id')
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    ownerId: text('owner_id').references(() => users.id),
    name: text('name').notNull(),
    layerType: text('layer_type').notNull().default('raster'), // 'raster' | 'folder' | 'adjustment'
    blendMode: text('blend_mode').notNull().default('normal'),
    opacity: real('opacity').notNull().default(1.0),
    isVisible: integer('is_visible').notNull().default(1),
    isLocked: integer('is_locked').notNull().default(0),
    alphaLocked: integer('alpha_locked').notNull().default(0),
    clipToBelow: integer('clip_to_below').notNull().default(0),
    screentoneEnabled: integer('screentone_enabled').notNull().default(0),
    screentoneLpi: integer('screentone_lpi').notNull().default(40),
    screentoneAngle: real('screentone_angle').notNull().default(45),
    screentoneDotScale: real('screentone_dot_scale').notNull().default(1.0),
    sortOrder: integer('sort_order').notNull(),
    aclMode: text('acl_mode').notNull().default('owner_only'), // 'owner_only' | 'shared_all' | 'custom'
    isPublic: integer('is_public').notNull().default(0),
    meta: text('meta'), // JSON LayerMeta: animation folder, text layer source
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    canvasOrderIdx: index('idx_layers_canvas_order').on(table.canvasId, table.sortOrder),
  })
);

// 5. 細粒度圖層權限表 (當 acl_mode = 'custom' 時生效)
export const layerPermissions = sqliteTable(
  'layer_permissions',
  {
    layerId: text('layer_id')
      .notNull()
      .references(() => layers.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    canDraw: integer('can_draw').notNull().default(1),
    canErase: integer('can_erase').notNull().default(1),
    canFilter: integer('can_filter').notNull().default(1),
    canModifyProps: integer('can_modify_props').notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.layerId, table.userId] }),
  })
);

// 6. 畫布快照檢查點
export const canvasSnapshots = sqliteTable(
  'canvas_snapshots',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id')
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    storagePath: text('storage_path').notNull(),
    byteSize: integer('byte_size').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    canvasSeqIdx: index('idx_snapshots_canvas_seq').on(table.canvasId, table.seq),
  })
);

// 7. 增量操作日誌
export const canvasOps = sqliteTable(
  'canvas_ops',
  {
    canvasId: text('canvas_id')
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    layerId: text('layer_id'),
    opType: text('op_type').notNull(), // 'STROKE' | 'FILL' | 'FILTER' | 'LAYER_OP' | 'TILE_PATCH'
    payloadBlob: blob('payload_blob', { mode: 'buffer' }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.canvasId, table.seq] }),
  })
);
