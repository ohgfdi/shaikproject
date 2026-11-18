/**
 * Phase 13: Comment Card Component
 *
 * A reusable comment component for datasets, insights, and dashboards.
 * Supports threading, replies, and user mentions.
 */
import Image from "next/image";
import React, { useState } from "react";

export interface Comment {
  id: string;
  userId: string;
  userName: string;
  userAvatar?: string;
  text: string;
  createdAt: Date;
  postType: "dataset" | "analysis" | "dashboard" | "book";
  postId: string;
  likes: number;
  likedByCurrentUser: boolean;
  replies?: Comment[];
}

export interface CommentCardProps {
  comment: Comment;
  onLike?: (commentId: string) => void;
  onDelete?: (commentId: string) => void;
  depth?: number; // For nesting level
}

export const CommentCard: React.FC<CommentCardProps> = ({
  comment,
  onLike,
  onDelete,
  depth = 0,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [newText, setNewText] = useState(comment.text);

  const handleLike = () => {
    onLike?.(comment.id);
  };

  const handleDelete = () => {
    onDelete?.(comment.id);
  };

  if (isEditing) {
    return (
      <div className="comment-editing">
        <textarea
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          className="comment-textarea"
          placeholder="Update comment..."
        />
        <div className="comment-actions">
          <button
            onClick={() => setIsEditing(false)}
            className="btn btn-secondary"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              // TODO: Send update to server
              setIsEditing(false);
            }}
            className="btn btn-primary"
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="comment-card">
      <div className="comment-header">
        <Image
          src={comment.userAvatar || "/avatars/default.png"}
          alt={comment.userName}
          className="comment-avatar"
          width={36}
          height={36}
          unoptimized
        />
        <span className="comment-author">{comment.userName}</span>
        <span className="comment-time">
          {new Date(comment.createdAt).toLocaleTimeString()}
        </span>
      </div>

      <p className="comment-text">{comment.text}</p>

      {depth > 0 && (
        <button
          className="comment-reply-btn"
          onClick={() => {
            // TODO: Open reply composer
          }}
        >
          Reply
        </button>
      )}

      {comment.likes > 0 && (
        <div className="comment-likes">
          <button
            className="like-button"
            onClick={handleLike}
            aria-pressed={comment.likedByCurrentUser}
          >
            <span className="like-count">
              {comment.likes}{comment.likedByCurrentUser ? " · You" : ""}
            </span>
          </button>
        </div>
      )}

      {comment.replies && comment.replies.length > 0 && (
        <div className="comment-replies">
          {comment.replies.map((reply) => (
            <CommentCard
              key={reply.id}
              comment={reply}
              onLike={onLike}
              onDelete={onDelete}
              depth={depth + 1}
            />
          ))}
        </div>
      )}

      {isEditing ? null : (
        <div className="comment-actions-bar">
          <button
            className="comment-menu-btn"
            onClick={() => { /* open menu */ }}
          >
            ⋯
          </button>
          <menu>
            <menuitem onClick={handleDelete}>Delete</menuitem>
          </menu>
        </div>
      )}
    </div>
  );
};