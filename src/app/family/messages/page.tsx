'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getMessages, addMessage, type Message } from '@/lib/storage';

const QUICK_MESSAGES = [
  '元気にしてる？🌸',
  '今日もよろしくね！',
  '会いに行くよ😊',
  '体に気をつけてね💪',
  '愛してるよ❤️',
  '何か食べたいものある？',
];

export default function FamilyMessagesPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');

  const reload = async () => {
    const msgs = await getMessages();
    setMessages(msgs);
  };

  useEffect(() => { reload(); }, []);

  const handleSend = async (content: string) => {
    if (!content.trim()) return;
    await addMessage('family', content);
    await reload();
    setText('');
  };

  return (
    <div className="flex flex-col min-h-screen">
      <div className="sticky top-0 bg-white border-b border-amber-100 px-5 py-4 flex items-center gap-3">
        <Link href="/family" className="text-2xl">←</Link>
        <h1 className="text-xl font-bold text-amber-800">💌 メッセージを送る</h1>
      </div>

      <div className="flex-1 px-5 py-4 flex flex-col gap-4 overflow-y-auto pb-72">
        {messages.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-5xl mb-4">💬</div>
            <p className="text-amber-700">最初のメッセージを送りましょう</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.from === 'family' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-xs rounded-3xl px-5 py-4 shadow-sm ${
                msg.from === 'family'
                  ? 'bg-amber-500 text-white rounded-br-sm'
                  : 'bg-white text-gray-800 border border-green-200 rounded-bl-sm'
              }`}>
                {msg.from === 'senior' && (
                  <p className="text-xs text-green-600 font-bold mb-1">👴 お父さん・お母さんから</p>
                )}
                <p className="text-base leading-relaxed">{msg.content}</p>
                <p className={`text-xs mt-2 ${msg.from === 'family' ? 'text-amber-200' : 'text-gray-400'}`}>
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
          {QUICK_MESSAGES.map((qm) => (
            <button key={qm} onClick={() => handleSend(qm)}
              className="flex-shrink-0 bg-amber-50 border border-amber-200 text-amber-800 rounded-2xl px-3 py-2 text-sm font-medium active:bg-amber-100 whitespace-nowrap">
              {qm}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input type="text" value={text} onChange={(e) => setText(e.target.value)}
            placeholder="メッセージを書く..."
            className="flex-1 border-2 border-amber-200 rounded-2xl px-4 py-3 text-base bg-white focus:outline-none focus:border-amber-400"
            onKeyDown={(e) => e.key === 'Enter' && handleSend(text)} />
          <button onClick={() => handleSend(text)}
            className="bg-amber-500 text-white rounded-2xl px-5 py-3 font-bold active:bg-amber-600">
            送る
          </button>
        </div>
      </div>
    </div>
  );
}
