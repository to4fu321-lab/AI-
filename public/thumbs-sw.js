// サムネ収集：プッシュ通知を受け取って表示するだけの Service Worker（ページの読み込みには関わらない）
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "サムネ収集", {
      body: data.body || "新しい動画が見つかりました",
      tag: data.tag || "thumbs-new",
      renotify: true,
      data: { url: data.url || "/thumbs" },
    }),
  );
});

// 通知をタップしたら、アプリを開く（開いていればそれを前に出す）
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/thumbs", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(url) && "focus" in c) return c.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
