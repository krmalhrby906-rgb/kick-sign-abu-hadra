MOD STREAM + KICK ACTIVITY
===========================

وش يسوي؟
- المود يسجل دخول بالموقع باسمه + PIN.
- كل مود مربوط بـ Kick Username.
- أي رسالة يكتبها المود في شات Kick تحدث نشاطه تلقائيًا.
- إذا كتب خلال آخر 30 دقيقة يظهر: نشط ✅
- إذا ما كتب بعد تسجيل الدخول يظهر: بانتظار أول رسالة ⏳
- إذا مر أكثر من 30 دقيقة من آخر رسالة يظهر: ساكت ⚠️
- ما يسجل خروج تلقائي؛ فقط يعطي الإدارة حالة واضحة.
- اللوقات تسجل نشاط Kick للمودات المسجلين دخول.
- يدعم حدث بداية/نهاية بث Kick تلقائيًا إذا تم الاشتراك.

الملفات التي ترفعها إلى GitHub:
public/
netlify/
package.json
netlify.toml

بعد ما Netlify ينشر النسخة:

1) في Netlify:
Project configuration > Environment variables

أضف:
ADMIN_PIN = 6868
KICK_CLIENT_ID = Client ID من Kick Developer
KICK_CLIENT_SECRET = Client Secret من Kick Developer
KICK_CHANNEL_SLUG = اسم قناة Kick فقط بدون https://kick.com/
KICK_ACTIVITY_MINUTES = 30
WEEKLY_TARGET = 60

2) في Kick:
Settings > Developer > App
أنشئ App إذا ما عندك.

Webhook URL حطه بهذا الشكل:
https://اسم-موقعك.netlify.app/.netlify/functions/kick-webhook

3) بعد ما تحفظ إعداد Kick:
افتح موقعك > الإدارة > اضغط "ربط/تحديث Kick"

الموقع بيجيب App Access Token تلقائيًا، يجيب Broadcaster ID من KICK_CHANNEL_SLUG،
ويشترك في:
chat.message.sent
livestream.status.updated

4) لكل مود:
من الإدارة أضف:
- اسم المود بالموقع
- PIN
- Kick Username الحقيقي بدون @

إذا عندك مودات قديمة:
اضغط زر Kick بجنب اسمه وحط Kick Username.

ملاحظة:
Webhook URL لازم يكون نفس رابط موقع Netlify الحالي.
