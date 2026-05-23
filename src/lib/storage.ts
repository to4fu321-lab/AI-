export type Mood = 'genki' | 'maama' | 'shindoi';

export interface Checkin {
  date: string;
  mood: Mood;
  time: string; // "HH:MM" — 生活リズム検知用
}

export interface QuizResult {
  date: string;
  correct: boolean;
}

export interface Message {
  id: string;
  from: 'family' | 'senior';
  content: string;
  imageData?: string; // base64
  timestamp: number;
  read: boolean;
}

export interface PhotoPost {
  id: string;
  imageData: string; // base64
  caption: string;
  timestamp: number;
}

export function getPhotoPosts(): PhotoPost[] {
  if (typeof window === 'undefined') return [];
  const data = localStorage.getItem('photoPosts');
  return data ? JSON.parse(data) : [];
}

export function addPhotoPost(imageData: string, caption: string): void {
  const posts = getPhotoPosts();
  posts.unshift({ id: Date.now().toString(), imageData, caption, timestamp: Date.now() });
  // 最大10件保持
  localStorage.setItem('photoPosts', JSON.stringify(posts.slice(0, 10)));
}

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

export function getTodayString(): string {
  return new Date().toISOString().split('T')[0];
}

export function getCheckins(): Checkin[] {
  if (typeof window === 'undefined') return [];
  const data = localStorage.getItem('checkins');
  return data ? JSON.parse(data) : [];
}

export function addCheckin(mood: Mood): void {
  const checkins = getCheckins();
  const today = getTodayString();
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const filtered = checkins.filter((c) => c.date !== today);
  filtered.push({ date: today, mood, time });
  localStorage.setItem('checkins', JSON.stringify(filtered));
}

export function saveQuizResult(correct: boolean): void {
  const results: QuizResult[] = JSON.parse(localStorage.getItem('quizResults') || '[]');
  results.push({ date: getTodayString(), correct });
  localStorage.setItem('quizResults', JSON.stringify(results.slice(-30)));
}

export function getTodayQuizDone(): boolean {
  if (typeof window === 'undefined') return false;
  const results: QuizResult[] = JSON.parse(localStorage.getItem('quizResults') || '[]');
  return results.some((r) => r.date === getTodayString());
}

export function getQuizResults(): QuizResult[] {
  if (typeof window === 'undefined') return [];
  return JSON.parse(localStorage.getItem('quizResults') || '[]');
}

// 生活リズムスコアを計算（家族向け）
export function getRhythmAnalysis() {
  const checkins = getCheckins().filter((c) => c.time);
  if (checkins.length < 3) return null;

  const toMinutes = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };

  const recent7 = checkins.slice(-7).map((c) => toMinutes(c.time));
  const avg = Math.round(recent7.reduce((a, b) => a + b, 0) / recent7.length);
  const maxDiff = Math.max(...recent7) - Math.min(...recent7);

  const avgH = Math.floor(avg / 60);
  const avgM = avg % 60;

  // 気分トレンド
  const moods = checkins.slice(-7).map((c) => c.mood);
  const shindoiCount = moods.filter((m) => m === 'shindoi').length;

  // クイズ正解率
  const results = getQuizResults().slice(-7);
  const quizRate = results.length > 0
    ? Math.round((results.filter((r) => r.correct).length / results.length) * 100)
    : null;

  return {
    avgCheckinTime: `${avgH}:${String(avgM).padStart(2, '0')}`,
    rhythmVariation: maxDiff,            // 分単位のばらつき
    shindoiCount,                        // 直近7日のしんどい日数
    quizRate,                            // クイズ正解率%
    alert: maxDiff > 180 || shindoiCount >= 4, // 要注意フラグ
  };
}

export function getTodayCheckin(): Checkin | null {
  const today = getTodayString();
  return getCheckins().find((c) => c.date === today) || null;
}

export function getStreak(): number {
  const checkins = getCheckins();
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

export function getMessages(): Message[] {
  if (typeof window === 'undefined') return [];
  const data = localStorage.getItem('messages');
  return data ? JSON.parse(data) : [];
}

export function addMessage(from: 'family' | 'senior', content: string): void {
  const messages = getMessages();
  messages.push({
    id: Date.now().toString(),
    from,
    content,
    timestamp: Date.now(),
    read: false,
  });
  localStorage.setItem('messages', JSON.stringify(messages));
}

export function markFamilyMessagesRead(): void {
  const messages = getMessages().map((m) =>
    m.from === 'family' ? { ...m, read: true } : m
  );
  localStorage.setItem('messages', JSON.stringify(messages));
}

export function getUnreadCount(): number {
  return getMessages().filter((m) => m.from === 'family' && !m.read).length;
}

export function getSeniorName(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('seniorName') || '';
}

export function setSeniorName(name: string): void {
  localStorage.setItem('seniorName', name);
}
