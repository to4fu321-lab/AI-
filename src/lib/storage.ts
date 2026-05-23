import { supabase } from './supabase';

export type Mood = 'genki' | 'maama' | 'shindoi';

export interface Checkin {
  date: string;
  mood: Mood;
  time: string;
}

export interface QuizResult {
  date: string;
  correct: boolean;
}

export interface Message {
  id: string;
  from: 'family' | 'senior';
  content: string;
  image_data?: string;
  timestamp: number;
  read: boolean;
}

export interface PhotoPost {
  id: string;
  image_data: string;
  caption: string;
  timestamp: number;
}

export function getTodayString(): string {
  return new Date().toISOString().split('T')[0];
}

// ── Checkins ──────────────────────────────────────────────

export async function getCheckins(): Promise<Checkin[]> {
  const { data } = await supabase
    .from('checkins')
    .select('date, mood, time')
    .order('date', { ascending: true });
  return (data as Checkin[]) ?? [];
}

export async function addCheckin(mood: Mood): Promise<void> {
  const today = getTodayString();
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  await supabase
    .from('checkins')
    .upsert({ date: today, mood, time }, { onConflict: 'date' });
}

export async function getTodayCheckin(): Promise<Checkin | null> {
  const { data } = await supabase
    .from('checkins')
    .select('date, mood, time')
    .eq('date', getTodayString())
    .maybeSingle();
  return (data as Checkin | null);
}

export async function getStreak(): Promise<number> {
  const checkins = await getCheckins();
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    if (checkins.find((c) => c.date === dateStr)) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// ── Quiz ──────────────────────────────────────────────────

export async function saveQuizResult(correct: boolean): Promise<void> {
  await supabase
    .from('quiz_results')
    .insert({ date: getTodayString(), correct });
}

export async function getTodayQuizDone(): Promise<boolean> {
  const { data } = await supabase
    .from('quiz_results')
    .select('id')
    .eq('date', getTodayString())
    .limit(1);
  return (data?.length ?? 0) > 0;
}

export async function getQuizResults(): Promise<QuizResult[]> {
  const { data } = await supabase
    .from('quiz_results')
    .select('date, correct')
    .order('id', { ascending: false })
    .limit(30);
  return (data as QuizResult[]) ?? [];
}

// ── Rhythm Analysis ───────────────────────────────────────

export async function getRhythmAnalysis() {
  const checkins = await getCheckins();
  const withTime = checkins.filter((c) => c.time);
  if (withTime.length < 3) return null;

  const toMinutes = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };

  const recent7 = withTime.slice(-7).map((c) => toMinutes(c.time));
  const avg = Math.round(recent7.reduce((a, b) => a + b, 0) / recent7.length);
  const maxDiff = Math.max(...recent7) - Math.min(...recent7);
  const avgH = Math.floor(avg / 60);
  const avgM = avg % 60;

  const moods = checkins.slice(-7).map((c) => c.mood);
  const shindoiCount = moods.filter((m) => m === 'shindoi').length;

  const results = await getQuizResults();
  const recent = results.slice(0, 7);
  const quizRate = recent.length > 0
    ? Math.round((recent.filter((r) => r.correct).length / recent.length) * 100)
    : null;

  return {
    avgCheckinTime: `${avgH}:${String(avgM).padStart(2, '0')}`,
    rhythmVariation: maxDiff,
    shindoiCount,
    quizRate,
    alert: maxDiff > 180 || shindoiCount >= 4,
  };
}

// ── Messages ──────────────────────────────────────────────

export async function getMessages(): Promise<Message[]> {
  const { data } = await supabase
    .from('messages')
    .select('*')
    .order('timestamp', { ascending: true });
  return (data as Message[]) ?? [];
}

export async function addMessage(
  from: 'family' | 'senior',
  content: string,
  imageData?: string
): Promise<void> {
  await supabase.from('messages').insert({
    id: Date.now().toString(),
    from,
    content,
    image_data: imageData ?? null,
    timestamp: Date.now(),
    read: false,
  });
}

export async function markFamilyMessagesRead(): Promise<void> {
  await supabase
    .from('messages')
    .update({ read: true })
    .eq('from', 'family')
    .eq('read', false);
}

export async function getUnreadCount(): Promise<number> {
  const { count } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('from', 'family')
    .eq('read', false);
  return count ?? 0;
}

// ── Settings (senior name) ────────────────────────────────

export async function getSeniorName(): Promise<string> {
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'seniorName')
    .maybeSingle();
  return data?.value ?? '';
}

export async function setSeniorName(name: string): Promise<void> {
  await supabase
    .from('settings')
    .upsert({ key: 'seniorName', value: name }, { onConflict: 'key' });
}

// ── Photo Posts ───────────────────────────────────────────

export async function getPhotoPosts(): Promise<PhotoPost[]> {
  const { data } = await supabase
    .from('photo_posts')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(10);
  return (data as PhotoPost[]) ?? [];
}

export async function addPhotoPost(image_data: string, caption: string): Promise<void> {
  await supabase.from('photo_posts').insert({
    id: Date.now().toString(),
    image_data,
    caption,
    timestamp: Date.now(),
  });
}

// ── Image compression (unchanged) ────────────────────────

export function compressImage(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX = 800;
        let { width, height } = img;
        if (width > height && width > MAX) { height = (height * MAX) / width; width = MAX; }
        else if (height > MAX) { width = (width * MAX) / height; height = MAX; }
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      };
      img.src = e.target!.result as string;
    };
    reader.readAsDataURL(file);
  });
}
