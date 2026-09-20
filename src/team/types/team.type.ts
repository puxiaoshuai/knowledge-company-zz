import type { TeamStatus } from '../entities/team.entity.js';
import type { TeamMemberRole } from '../entities/team-member.entity.js';

/** 团队管理端的平铺视图（分页列表项 / 详情共用） */
export interface TeamDetail {
  id: string;
  parentId: string;
  teamName: string;
  teamCode: string | null;
  description: string | null;
  leaderId: string | null;
  sort: number;
  status: TeamStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** 管理端团队树节点（含禁用节点；不含时间戳） */
export interface TeamTreeNode {
  id: string;
  parentId: string;
  teamName: string;
  teamCode: string | null;
  description: string | null;
  leaderId: string | null;
  sort: number;
  status: TeamStatus;
  children: TeamTreeNode[];
}

/** 团队分页结果 */
export interface TeamListResult {
  items: TeamDetail[];
  total: number;
  page: number;
  pageSize: number;
}

/** 删除结果 */
export interface DeleteTeamResult {
  id: string;
  deleted: true;
}

/** 成员视图（join kh_user 带用户信息） */
export interface TeamMemberDetail {
  /** 关联行 ID（雪花） */
  id: string;
  userId: string;
  username: string;
  realName: string | null;
  avatar: string | null;
  memberRole: TeamMemberRole;
  createdAt: Date;
}

/** 成员分页结果 */
export interface TeamMemberListResult {
  items: TeamMemberDetail[];
  total: number;
  page: number;
  pageSize: number;
}

/** PUT /teams/:id/members 的响应：成员全量明细（重读回显） */
export interface TeamMembersResult {
  teamId: string;
  members: TeamMemberDetail[];
}
