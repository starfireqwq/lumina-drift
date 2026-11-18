export interface ChatMessage {
  id: string;
  canvasId: string;
  userId: string;
  displayName: string;
  avatarUrl?: string | null;
  color: string;
  text: string;
  timestamp: number;
}
