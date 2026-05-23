'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  getMessages,
  addMessage,
  markFamilyMessagesRead,
  type Message,
} from '@/lib/storage';

const STAMPS = ['👍', '❤️', '😊', '🙏', '👏', '🌸', '🎉', '💪'];

export default function SeniorMessagesPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [reply, setReply] = useState('');

  const reload = async () => {
    const msgs = await getMessages();
    setMessages(msgs);
  };

  useEffect(() => {
    (async () => {
      await markFamilyMessagesRead();
      await reload();
    })();
  }, []);

  const handleSend = async (content: string) => {
    if (!content.trim()) return;
    await addMessage('senior', content);
    await reload();
    setReply('');
  };

  return (
    <div className="flex flex-col min-h-screen">
      <div className="sticky top-0 bg-white border-b border-amber-100 px-5 py-4 flex items-center gap-3">
        <Link href="/senior" className="text-2xl">←</Link>
        <h1 className="text-xl font-bold text-green-800">💌 家族からのメッセージ</h1>
      </div>

      <div className="flex-1 px-5 py-4 flex flex-col gap-4 overflow-y-auto pb-64">
        {messages.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-5xl mb-4">📭</div>
            <p className="text-amber-700 text-lg">まだメッセージはありません</p>
            <p className="text-sm text-gray-500 mt-2">家族からのメッセージがここに届きます</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.from === 'senior' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-xs rounded-3xl px-5 py-4 shadow-sm ${
                msg.from === 'senior'
                  ? 'bg-green-600 text-white rounded-br-sm'
                  : 'bg-white text-gray-800 border border-amber-100 rounded-bl-sm'
              }`}>
                {msg.from === 'family' && (
                  <p className="text-xs text-amber-600 font-bold mb-1">👨‍👩‍👧 家族から</p>
                )}
                <p className="text-base leading-relaxed">{msg.content}</p>
                <p className={`text-xs mt-2 ${msg.from === 'senior' ? 'text-green-200' : 'text-gray-400'}`}>
                  {new Date(msg.timestamp).toLocaleString('ja-JP', {
                    month: 'numeric', day: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  })}
                </p>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white border-t border-amber-100 px-4 py-4">
        <div className="flex gap-2 mb-3 overflow-x-auto pb-1">
          {STAMPS.map((stamp) => (
            <button key={stamp} onClick={() => handleSend(stamp)}
              className="text-3xl flex-shrink-0 w-12 h-12 flex items-center justify-center bg-amber-50 rounded-2xl active:scale-95 transition-transform">
              {stamp}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input type="text" value={reply} onChange={(e) => setReply(e.target.value)}
            placeholder="メッセージを書く..."
            className="flex-1 border-2 border-green-200 rounded-2xl px-4 py-3 text-base bg-white focus:outline-none focus:border-green-400"
            onKeyDown={(e) => e.key === 'Enter' && handleSend(reply)} />
          <button onClick={() => handleSend(reply)}
            className="bg-green-600 text-white rounded-2xl px-5 py-3 font-bold active:bg-green-700">
            送る
          </button>
        </div>
      </div>
    </div>
  );
}
