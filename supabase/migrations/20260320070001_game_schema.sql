-- Game Schema for Prompt Defense Competition

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enums
CREATE TYPE challenge_type AS ENUM ('tool-calling', 'secret-key');
CREATE TYPE user_role AS ENUM ('admin', 'player');
CREATE TYPE team_role AS ENUM ('leader', 'member');

-- Profiles
CREATE TABLE profiles (
  id UUID REFERENCES auth.users(id) PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  role user_role DEFAULT 'player'::user_role,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Games (Framework)
CREATE TABLE games (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  challenges_per_team INT NOT NULL DEFAULT 5,
  lives_per_challenge INT NOT NULL DEFAULT 3,
  is_active BOOLEAN DEFAULT false,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Teams
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(game_id, name)
);

-- Team Members
CREATE TABLE team_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  role team_role DEFAULT 'member'::team_role,
  kills INT DEFAULT 0,
  joined_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(team_id, user_id)
);

-- Reusable Tools
CREATE TABLE tools (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  spec JSONB NOT NULL, -- OpenRouter tool specification
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Reusable Interp Args
CREATE TABLE interp_args (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL UNIQUE,
  configuration JSONB NOT NULL,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Admin Challenges
CREATE TABLE challenges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  model_name TEXT NOT NULL,
  description TEXT NOT NULL,
  default_prompt TEXT,
  context TEXT,
  type challenge_type NOT NULL,
  target_tool_name TEXT, -- only for tool-calling
  interp_arg_id UUID REFERENCES interp_args(id), -- optional Llama-interp-server configuration
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Challenge Tools (Junction Table)
CREATE TABLE challenge_tools (
  challenge_id UUID REFERENCES challenges(id) ON DELETE CASCADE,
  tool_id UUID REFERENCES tools(id) ON DELETE CASCADE,
  PRIMARY KEY (challenge_id, tool_id)
);

-- Defended Challenges (Team's defense configuration)
CREATE TABLE defended_challenges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  challenge_id UUID REFERENCES challenges(id) ON DELETE CASCADE,
  system_prompt TEXT NOT NULL,
  target_secret_key TEXT, -- Assigned internally from dictionary
  lives_remaining INT NOT NULL DEFAULT 3, -- Starts at game.lives_per_challenge
  is_active BOOLEAN DEFAULT true, -- Becomes false when lives hit 0
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(team_id, challenge_id)
);

-- Attacks
CREATE TABLE attacks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  attacker_user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  attacker_team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  defended_challenge_id UUID REFERENCES defended_challenges(id) ON DELETE CASCADE,
  is_successful BOOLEAN NOT NULL DEFAULT false,
  log JSONB, -- Conversation log
  created_at TIMESTAMPTZ DEFAULT now()
);

-- RLS Settings (Simple stub)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE interp_args ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenge_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE defended_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE attacks ENABLE ROW LEVEL SECURITY;

-- Storage setup
INSERT INTO storage.buckets (id, name, public) VALUES ('game-assets', 'game-assets', true);
INSERT INTO storage.buckets (id, name, public) VALUES ('attack-logs', 'attack-logs', false);
