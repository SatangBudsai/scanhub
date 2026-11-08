![ScanHub: ผลสแกนความปลอดภัยทุก tool รวมไว้ที่เดียว รู้ทันทีว่าอะไรใหม่และอะไรแก้แล้ว](docs/media/banner.png)

# ScanHub

รวมผลสแกนความปลอดภัยจาก SonarQube, Trivy, Semgrep, Gitleaks, Grype, Checkov และ OWASP Dependency-Check ไว้ที่เดียว แยกตาม project › repo มีประวัติทุกครั้งที่สแกน ผลจากทุก tool รวมเป็นรายการเดียว และเทียบกับสแกนครั้งก่อนให้เห็นว่าอะไรใหม่ อะไรแก้แล้ว

![ภาพรวมผลสแกนของ repo: ตัวเลขสรุป ระดับความรุนแรง และรายการปัญหาจากทุก scanner](docs/media/results-overview.gif)

- **ติดตั้งด้วยไฟล์เดียว**: แก้ `docker-compose.yml` แล้ว `docker compose up -d` ใน container เดียวมีทั้งเว็บ, PostgreSQL และ scanner ทุกตัว
- **เชื่อม CI แบบกดครั้งเดียว**: GitHub / GitLab ตั้ง secret และเปิด Pull Request ให้เอง หรือ copy โค้ดสำหรับ Jenkins, Azure, Bitbucket และ CLI
- **เลือกได้ว่าจะ block pipeline หรือแค่แจ้งผล** และเปลี่ยนทีหลังได้โดยไม่ต้องแก้ pipeline
- **รายงานส่งลูกค้า** เป็น PDF / HTML และ share link แบบเฉพาะคนในระบบหรือแบบตั้งรหัสผ่าน
- **ผู้ใช้ กลุ่ม และสิทธิ์รายโปรเจกต์**: admin มาจาก config และตั้งค่าใหม่ทุกครั้งที่ start
- **scanner อัปเดตเองทุกวัน** ขณะที่ระบบรันอยู่

---

## 1. ติดตั้ง

ต้องมี Docker เท่านั้น

1. เปิด `docker-compose.yml` แล้วแก้ 3 บรรทัด

   ```yaml
   SCANHUB_ADMIN_USER: admin
   SCANHUB_ADMIN_PASSWORD: your-strong-password   # อย่างน้อย 8 ตัว
   SCANHUB_URL: https://scanhub.company.local     # URL ที่คนและ CI ใช้เข้า ScanHub
   ```

2. สั่ง `docker compose up -d --build`
3. เปิด `SCANHUB_URL` แล้ว login ด้วย admin ครั้งแรกจะมีหน้าให้เลือก scanner และเวลาอัปเดตรายวัน

![ตั้งค่าครั้งแรก: เลือก scanner และเวลาอัปเดตอัตโนมัติ](docs/media/setup.gif)

ถ้ายังไม่เปลี่ยนรหัส admin ตัวอย่าง ระบบจะไม่ยอม start ข้อมูลทั้งหมดเก็บใน volume `scanhub-data`

### ค่าเสริม

ทั้งหมดอยู่ใน `docker-compose.yml` ไฟล์เดียว ลบ `#` หน้าบรรทัดเพื่อเปิดใช้

| ค่า | ใช้ทำอะไร |
| --- | --- |
| `DATABASE_URL` | ใช้ PostgreSQL ที่มีอยู่แล้ว ถ้าตั้งค่านี้ PostgreSQL ใน container จะไม่ถูก start |
| `SONAR_URL`, `SONAR_TOKEN` | SonarQube server ที่มีอยู่ ScanHub จะส่งโค้ดไปวิเคราะห์และดึงผลกลับมา |
| `NVD_API_KEY` | ให้ OWASP Dependency-Check โหลดฐานข้อมูลครั้งแรกได้เร็ว (ขอฟรีที่ nvd.nist.gov) |
| `GITHUB_TOKEN`, `GITHUB_API_URL` | เชื่อม GitHub / GitHub Enterprise สำหรับตั้งค่า CI อัตโนมัติ |
| `GITLAB_URL`, `GITLAB_TOKEN` | เชื่อม GitLab (gitlab.com หรือ server ของคุณ) สำหรับตั้งค่า CI อัตโนมัติ |
| `TZ` | เขตเวลาของงานรายวัน (ค่าเริ่มต้น `Asia/Bangkok`) |
| `SCAN_CONCURRENCY`, `MAX_UPLOAD_MB` | จำนวนสแกนพร้อมกัน, ขนาด source สูงสุดที่ CI ส่งมา |

ค่าที่ตั้งในไฟล์นี้จะแสดงในหน้าตั้งค่าเป็น "ตั้งค่าจาก env" และแก้จากหน้าเว็บไม่ได้

---

## 2. เชื่อมต่อ CI/CD

เปิด repo แล้วกด **เชื่อมต่อ CI**

### ตั้งค่าอัตโนมัติ (GitHub / GitLab)

1. เลือกการเชื่อมต่อและ repo ปลายทาง
2. เลือกว่าจะ **Block** หรือ **แจ้งผลอย่างเดียว**
3. กด **ตั้งค่าให้อัตโนมัติ** ScanHub จะทำ 3 อย่างให้
   - เก็บ `SCANHUB_TOKEN` เป็น secret
   - เพิ่มไฟล์ pipeline
   - เปิด Pull Request / Merge Request
4. กด merge แล้วทุก push จะถูกสแกน

![ตั้งค่า CI อัตโนมัติกับ GitHub: ใส่ secret และ workflow แล้วเปิด Pull Request](docs/media/auto-setup-github.gif)

token ที่ใช้ต้องมีสิทธิ์ดังนี้

- **GitHub**: fine-grained PAT ที่ให้ Contents, Pull requests, Secrets, Variables, Workflows เป็น read/write (classic token: `repo`, `workflow`)
- **GitLab**: scope `api` และ role Maintainer

### Block หรือแค่แจ้งผล

- **Block**: pipeline fail เมื่อเจอปัญหาใหม่ระดับที่เลือก (Critical / Critical + High / Medium ขึ้นไป)
- **แจ้งผลอย่างเดียว**: pipeline ผ่านเสมอ

ทั้ง 2 แบบแสดงสรุปและลิงก์ผลสแกนใน log ของ CI ค่านี้เก็บไว้ที่ ScanHub จึงเปลี่ยนได้ทุกเมื่อโดยไม่ต้องแก้ pipeline

![อัปโหลดโค้ดแบบ CI: โหมด block ได้ 422 โหมดแจ้งผลได้ 200](docs/media/ci-gate.gif)

### Branch, tag และ Pull Request ที่สแกน

pipeline ที่ ScanHub สร้างให้รันทุก branch, tag และ PR แล้วถาม ScanHub ก่อนว่าต้องสแกนไหม ตั้งค่าที่หน้า **เชื่อมต่อ CI** ของแต่ละ repo เปลี่ยนได้ทุกเมื่อโดยไม่ต้องแก้ pipeline ตัวที่ไม่ตรงจะจบทันทีโดยไม่อัปโหลดโค้ด

| ตั้งค่า | ตัวอย่าง | ค่าเริ่มต้น |
| --- | --- | --- |
| Branch | `main, develop, release/*` | branch หลักของ repo อย่างเดียว |
| Tag | `v*` หรือ `sit_v*, uat_v*` | ไม่สแกน tag |
| Pull Request / Merge Request | เปิด / ปิด | เปิด |

`*` ใช้ได้ทุกตำแหน่ง แต่ละสแกนเทียบผล "ใหม่ / แก้แล้ว" กับสแกนที่เหมาะสม

- **branch** เทียบกับสแกนก่อนหน้าของ branch เดียวกัน
- **PR** เทียบกับ branch ปลายทาง ปัญหาใหม่คือสิ่งที่ PR นั้นเพิ่มเข้ามา ใช้กับ block แบบ "เฉพาะปัญหาใหม่" ได้ตรง
- **tag** เทียบกับ tag ก่อนหน้าใน pattern เดียวกัน เช่น `sit_v1.2` เทียบกับ `sit_v1.1` ไม่ใช่ `uat_v1.1`

หน้า repo มีตัวเลือก branch / PR / tag และประวัติแสดงแยกตามที่เลือก pipeline ที่ตั้งไว้ก่อนมีฟีเจอร์นี้ยังใช้ได้ (สแกนทุกครั้งเหมือนเดิม) ตั้งค่าอัตโนมัติอีกครั้งหรือ copy โค้ดใหม่เพื่อใช้การเลือก branch และ tag

### ตั้งค่าเอง

copy โค้ดสำหรับ GitHub Actions, GitLab CI, Jenkins, Azure Pipelines, Bitbucket หรือ CLI แล้วเพิ่ม secret `SCANHUB_TOKEN` CI แค่ส่ง source code มา ScanHub สแกนด้วย scanner ของตัวเอง ฝั่ง CI จึงไม่ต้องติดตั้งอะไรเลย

```sh
# KIND = branch | tag | pr, BASE = branch ปลายทางของ PR
Q="kind=$KIND&branch=$REF&base=$BASE"
case "$(curl -sS -H "Authorization: Bearer $SCANHUB_TOKEN" -H "Accept: text/plain" "$SCANHUB_URL/api/v1/check?$Q")" in skip*) exit 0;; esac
tar --exclude=.git -czf - . | curl --fail-with-body -sS -X POST -T - \
  -H "Authorization: Bearer $SCANHUB_TOKEN" -H "Content-Type: application/gzip" -H "Accept: text/plain" \
  "$SCANHUB_URL/api/v1/scan?$Q&commit=$COMMIT&wait=1"
```

ถ้ารัน scanner ใน CI อยู่แล้ว ส่งไฟล์ผล JSON/SARIF ไปที่ `/api/v1/reports` ได้เช่นกัน

CI runner ต้องเข้าถึง `SCANHUB_URL` ได้ ถ้า ScanHub อยู่ในเครือข่ายภายใน ให้ใช้ runner ที่อยู่ในเครือข่ายเดียวกัน

---

## 3. ดูผลสแกน

- **ปัญหาเดียวกันที่หลาย scanner เจอแสดงเป็นรายการเดียว** พร้อมชื่อทุก tool ที่เจอ
- เริ่มต้นแสดงเฉพาะที่ **ต้องดู** (ปัญหาใหม่ + Critical/High) กดเปลี่ยนเป็น **ทั้งหมด** หรือ **แก้แล้ว** ได้
- **กดที่ระดับความรุนแรง** เพื่อกรองเฉพาะระดับนั้น
- **กดที่ปัญหา** เพื่อดูโค้ดที่เกี่ยวข้อง วิธีแก้ และลิงก์อ้างอิง

![ค้นหา ตัวกรอง จัดกลุ่ม และรายละเอียดของปัญหาที่หลาย scanner เจอ](docs/media/findings-filter.gif)

ทุกครั้งที่สแกนเก็บเป็นประวัติ แยกตาม branch / PR / tag สลับดูสแกนเก่าได้ และดาวน์โหลด CSV ได้

![ประวัติการสแกน สลับสแกน และดาวน์โหลด CSV](docs/media/history.gif)

---

## 4. รายงานและการแชร์

ในหน้า repo กด **รายงาน**

### Export

ใส่ชื่อลูกค้า เลือกระดับความรุนแรงขั้นต่ำ เลือกว่าจะแสดงโค้ดหรือไม่ แล้วกด **บันทึกเป็น PDF** หรือ **ดาวน์โหลด HTML** ได้ A4 หน้าตาเหมือนกันไม่ว่าจะเปิดจากจอขนาดไหน

![ส่งออกรายงานสำหรับลูกค้าเป็น PDF และ HTML](docs/media/report-export.gif)

### Share link

- **เฉพาะผู้ใช้ในระบบ**: ต้อง login และมีสิทธิ์ในโปรเจกต์นั้น
- **ตั้งรหัสผ่าน**: ส่งให้คนนอกได้ ใส่รหัสผิด 5 ครั้งใน 15 นาทีจะถูกล็อกชั่วคราว

ตั้งวันหมดอายุได้ ยกเลิก link ได้ทุกเมื่อ และดูได้ว่าเปิดไปกี่ครั้ง

![ลิงก์ตั้งรหัสผ่าน: รหัสผิด รหัสถูก และล็อกหลังผิด 5 ครั้ง](docs/media/share-password.gif)

---

## 5. ผู้ใช้ กลุ่ม และสิทธิ์

ไม่มีการสมัครเอง admin เพิ่มผู้ใช้ในหน้า **ผู้ใช้** ผู้ใช้ใหม่ต้องเปลี่ยนรหัสผ่านชั่วคราวตอน login ครั้งแรก

| | ADMIN<br>ผู้ดูแลระบบ | MAINTAINER<br>ผู้ดูแลโปรเจกต์ | ANALYST<br>ผู้ตรวจสอบ | VIEWER<br>ผู้ดูผล |
| --- | --- | --- | --- | --- |
| ดูผลสแกน | ✓ | ✓ | ✓ | ✓ |
| สั่งสแกน, สร้าง share link | ✓ | ✓ | ✓ | |
| จัดการ project / repo / token / CI | ✓ | ✓ | | |
| ดูหน้าตั้งค่า | ✓ | ✓ | | |
| แก้ตั้งค่า, scanner, ผู้ใช้ | ✓ | | | |

**การมองเห็นโปรเจกต์:** ADMIN เห็นทุกโปรเจกต์ ผู้ใช้คนอื่นเห็นได้ 3 ทาง

- เปิด **เห็นทุกโปรเจกต์** ให้คนนั้น
- ให้สิทธิ์รายโปรเจกต์
- อยู่ใน **กลุ่ม** ที่มีสิทธิ์

คนที่สร้างโปรเจกต์จะเห็นโปรเจกต์นั้นอัตโนมัติ เมนู ⋯ ของโปรเจกต์มี **ใครเห็นโปรเจกต์นี้** ให้ตรวจได้

![ให้สิทธิ์ผ่านกลุ่ม รายคน และเห็นทุกโปรเจกต์ แล้วดูว่าใครเห็นโปรเจกต์](docs/media/access-groups.gif)

---

## 6. Scanner และการอัปเดต

scanner ทุกตัวติดตั้งมากับ image แล้ว เปิด/ปิดได้ในหน้า **ตั้งค่า**

ทุกวันตามเวลาที่ตั้ง (ค่าเริ่มต้น 03:00) ScanHub จะดาวน์โหลด scanner เวอร์ชันล่าสุดและฐานข้อมูลช่องโหว่มาเอง ขณะที่ระบบรันอยู่ ไม่ต้อง build ใหม่

- ถ้าอัปเดตตัวไหนล้มเหลว จะใช้เวอร์ชันเดิมต่อและบันทึกไว้
- ย้อนกลับไปใช้เวอร์ชันที่มากับ image ได้

![เปิด/ปิด scanner และดูเวอร์ชัน](docs/media/scanners.gif)

container ต้องออกอินเทอร์เน็ตได้ (GitHub, PyPI, SonarSource, NVD) การสแกนครั้งแรกจะช้ากว่าปกติ 3–4 นาที เพราะ Trivy และ Grype ต้องโหลดฐานข้อมูลช่องโหว่

ตัวโปรแกรม ScanHub เองอัปเดตด้วยการ pull โค้ดใหม่แล้วสั่ง `docker compose up -d --build` ข้อมูลเดิมยังอยู่ และฐานข้อมูลจะ migrate ให้อัตโนมัติ

---

## 7. ใช้บนมือถือได้

ทุกหน้าปรับตามขนาดจอ เมนูด้านบนยุบเป็นปุ่มเดียว ตารางเรียงเป็นการ์ด

<img src="docs/media/mobile.gif" alt="ScanHub บนจอมือถือ" width="360">

---

## สำหรับนักพัฒนา

```sh
npm install
npm test          # unit + API tests 36 รายการ (ใช้ PostgreSQL ชั่วคราวใน Docker)
npm run e2e       # Playwright E2E 35 รายการ บันทึก GIF ทุก test
npm run e2e:report
```

ผล E2E อยู่ที่ `e2e/results/index.html` แต่ละ test มีขั้นตอน ผลผ่าน/ไม่ผ่าน และ GIF ภาพทั้งหมดใน README นี้มาจากการรัน E2E จริง

| โฟลเดอร์ | |
| --- | --- |
| `server/` | Node.js 22 + Express + PostgreSQL |
| `public/` | หน้าเว็บ (`index.html`) และหน้ารายงาน (`report.html`) |
| `docker/` | entrypoint และสคริปต์ติดตั้ง scanner |
| `test/`, `e2e/` | ชุดทดสอบ |
| `docs/ARCHITECTURE.md` | โครงสร้างระบบและ API ทั้งหมด |
| `designs/` | ต้นแบบหน้าจอ 4 แบบที่ใช้เลือกดีไซน์ |

แนวทางดีไซน์อ้างอิง [unslop](https://github.com/heydamir/unslop) by Damir Sokolovsky, CC BY 4.0
