BEGIN;

-- Generic account/social read models used by Chats, Friends, Support and Posts.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS profile_image_url TEXT;

-- The original messages table carries a subject/media payload but no dedicated
-- chat body. Keep subject backward-compatible and store chat text explicitly.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS user_friends (
    friendship_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    friend_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'accepted'
      CHECK (status IN ('pending','accepted','blocked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (user_id <> friend_user_id)
);

CREATE INDEX IF NOT EXISTS user_friends_user_idx
  ON user_friends(user_id,status);
CREATE INDEX IF NOT EXISTS user_friends_friend_idx
  ON user_friends(friend_user_id,status);
CREATE UNIQUE INDEX IF NOT EXISTS user_friends_pair_uq
  ON user_friends (
    LEAST(user_id::text,friend_user_id::text),
    GREATEST(user_id::text,friend_user_id::text)
  );

-- Fifoo Support is a non-login system account so SupportView can use the exact
-- same conversations/messages schema as ordinary chats.
INSERT INTO users(
    user_id,username,first_name,last_name,email,password,last_active
) VALUES (
    '00000000-0000-4000-8000-00000000f100',
    'fifoo_support',
    'Fifoo',
    'Support',
    'support@fifoo.local',
    'system-account-disabled',
    NOW()
)
ON CONFLICT DO NOTHING;

COMMIT;
