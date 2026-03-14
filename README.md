# 🇩🇪 DeutschLernen — Застосунок для вивчення німецької

Full-stack веб-застосунок для вивчення німецького словникового запасу через ігри.

---

## 📁 Структура проєкту

```
german-app/
├── backend/          ← API-сервер на Node.js/Express
│   ├── server.js
│   ├── package.json
│   └── .env.example  ← Скопіюй у .env і заповни
│
├── frontend/         ← Основний навчальний сайт (статичні файли)
│   └── index.html
│
└── admin/            ← Адмін-панель (статичні файли, окремий деплой)
    └── index.html
```

---

## ⚙️ Налаштування

### 1. Firebase

1. Перейди на [Firebase Console](https://console.firebase.google.com) → Створи проєкт
2. **Увімкни Firestore**: Build → Firestore Database → Почати у production mode
3. **Увімкни автентифікацію**: Build → Authentication → Sign-in method → Email/Password
4. **Отримай конфіг веб-застосунку**: Project Settings → Your apps → Add web app → скопіюй конфіг
5. **Отримай облікові дані Admin SDK**: Project Settings → Service Accounts → Generate new private key

**Правила безпеки Firestore** (встанови у Firebase Console → Firestore → Rules):
```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Теми: всі можуть читати, прямий запис заборонено (тільки через бекенд)
    match /topics/{topicId} {
      allow read: if true;
      allow write: if false;
    }
    // Прогрес користувача: тільки власник може читати і писати
    match /users/{userId}/progress/{topicId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

---

### 2. Бекенд

```bash
cd backend

# Встанови залежності
npm install

# Скопіюй файл змінних середовища
cp .env.example .env

# Заповни .env своїми значеннями
nano .env    # або будь-який інший редактор

# Запуск для розробки
npm run dev

# Запуск для продакшну
npm start
```

**Обов'язкові значення у `.env`:**
- `ADMIN_PASSWORD` — пароль для адмін-панелі (обери надійний!)
- Конфіг Firebase веб-застосунку (`FIREBASE_API_KEY` тощо)
- Облікові дані Firebase Admin SDK (`FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`)

---

### 3. Фронтенд

Фронтенд — це **один статичний HTML-файл**, жодного білд-кроку не потрібно.

1. Відкрий `frontend/index.html` у редакторі
2. Зміни `BACKEND_URL` на початку `<script>` на адресу свого бекенду:
   ```javascript
   const BACKEND_URL = 'https://твій-бекенд.railway.app'; // або localhost:3001 для розробки
   ```
3. Розгорни на будь-якому статичному хостингу (Netlify, Vercel, GitHub Pages, nginx)
   - Для швидкого локального тестування: VS Code Live Server або `npx serve frontend/`

---

### 4. Адмін-панель

Так само, як фронтенд — статичний файл, розгортається окремо від основного сайту.

1. Відкрий `admin/index.html`
2. Зміни `BACKEND_URL` на початку `<script>`
3. Розгорни на окремій адресі (наприклад, `admin.твій-домен.com`)

**Можливості адмін-панелі:**
- Захист паролем через бекенд (пароль ніколи не зберігається у коді браузера)
- Додавання, редагування, видалення тем
- Масова вставка слів у форматі `der Wort — переклад`
- Токен сесії закінчується через 8 годин

---

## 🎮 Ігри

### 🎧 Диктант
- Слово озвучується через Web Speech API браузера (голос `de-DE`)
- Користувач вводить почуте слово
- Перевіряються всі слова теми у випадковому порядку
- Прогрес зберігається у Firestore (якщо користувач увійшов)

### ⚡ На швидкість
- Показується український переклад → потрібно написати слово по-німецьки
- Зворотній відлік 2 хвилини
- Якщо всі слова пройдено до кінця часу — починаються знову
- Найкращий результат зберігається у Firestore (якщо користувач увійшов)

---

## 🚀 Деплой

### Бекенд → Railway / Render / Fly.io

**Railway (рекомендовано):**
1. Запуш проєкт на GitHub
2. Створи новий Railway проєкт → Deploy from GitHub
3. Додай змінні середовища (з `.env`)
4. Railway автоматично визначить Node.js і встановить PORT

**Важливо для `FIREBASE_PRIVATE_KEY` на Railway/Render:**
- Вставляй ключ як є (Railway підтримує багаторядкові змінні)
- Екранувати `\n` не потрібно

### Фронтенд + Адмін → Netlify / Vercel

Просто перетягни папки `frontend/` та `admin/` окремо.
Або підключи GitHub-репозиторій до Netlify/Vercel.

**Не забудь оновити `BACKEND_URL` в обох HTML-файлах перед деплоєм!**

---

## 📊 Структура даних у Firestore

```
/topics/{topicId}
  name: "Familie"          # Назва теми (нім.)
  nameUk: "Сім'я"          # Назва теми (укр.)
  description: ""          # Опис (необов'язково)
  words: [
    { article: "der", german: "Vater", ukrainian: "батько" },
    { article: "die", german: "Mutter", ukrainian: "мати" },
    ...
  ]
  createdAt: Timestamp
  updatedAt: Timestamp (необов'язково)

/users/{userId}/progress/{topicId}
  dictation_score: 8       # Результат останнього диктанту
  dictation_total: 10      # Кількість слів у тій спробі
  dictation_attempts: 3    # Кількість зіграних разів
  speed_best: 15           # Найкращий результат гри на швидкість
  speed_attempts: 5
  lastPlayed: Timestamp
```

---

## 🔒 Безпека

- Firebase API ключ передається через бекенд (`/api/config`) — він ніколи не з'являється у коді фронтенду
- Пароль адміна зберігається тільки у `.env` бекенду — ніколи у коді браузера
- Сесії адміна використовують випадкові 32-байтні токени, що зберігаються у пам'яті сервера
- Правила Firestore забороняють прямий запис тем (тільки Admin SDK через бекенд може писати)
- На продакшні: встанови `ALLOWED_ORIGINS` у `.env` з конкретними адресами фронтенду
