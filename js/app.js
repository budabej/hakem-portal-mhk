// -----------------------------------------------------------------------
// MHK Paneli - istemci tarafı mantık.
// Bu dosya SADECE anon (public) Supabase anahtarını kullanır. Bu sayfaya
// giren herkes önce Supabase Auth ile giriş yapmak zorundadır; girişten
// sonra veri erişimi veritabanı tarafında RLS ile denetlenir: hesabının
// app_metadata.rol alanı 'mhk' olmayan biri hiçbir hakem satırını
// göremez/değiştiremez (bkz. sql/schema.sql, is_mhk()).
// -----------------------------------------------------------------------

const cfg = window.MHK_PANEL_CONFIG;
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const el = (id) => document.getElementById(id);
const goster = (id, evet) => { el(id).hidden = !evet; };

const KADEMELER = ["ADAY", "İL", "ULUSAL", "ULUSLARARASI"];

let tumHakemler = [];

async function baslat() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    await mhkMi();
  } else {
    ekranGoster("giris");
  }
}

function ekranGoster(ad) {
  goster("girisEkrani", ad === "giris");
  goster("panel", ad === "panel");
  goster("cikisBtn", ad === "panel");
}

async function mhkMi() {
  const { data: { user } } = await sb.auth.getUser();
  const rol = user?.app_metadata?.rol;
  if (rol !== "mhk") {
    el("girisHata").textContent = "Bu hesap MHK yetkisine sahip değil.";
    el("girisHata").hidden = false;
    await sb.auth.signOut();
    ekranGoster("giris");
    return;
  }
  ekranGoster("panel");
  await listeYukle();
}

async function listeYukle() {
  goster("listeYukleniyor", true);
  goster("hakemTablo", false);

  const { data, error } = await sb
    .from("hakemler")
    .select("*")
    .order("ad_soyad", { ascending: true });

  goster("listeYukleniyor", false);

  if (error) {
    el("listeYukleniyor").textContent = "Liste yüklenemedi: " + error.message;
    goster("listeYukleniyor", true);
    return;
  }

  tumHakemler = data || [];
  el("toplamSayi").textContent = tumHakemler.length;
  tabloCiz(tumHakemler);
  goster("hakemTablo", true);
}

function tabloCiz(liste) {
  const tbody = el("hakemTbody");
  tbody.innerHTML = "";

  for (const h of liste) {
    const tr = document.createElement("tr");
    tr.dataset.id = h.id;

    const kademeSecim = KADEMELER.map(
      (k) => `<option value="${k}" ${k === h.kademe ? "selected" : ""}>${k}</option>`
    ).join("");

    tr.innerHTML = `
      <td>${h.sicil_no}</td>
      <td><button class="btn btn-ghost btn-mini karne-btn" data-id="${h.id}" data-ad="${kacir(h.ad_soyad)}">${kacir(h.ad_soyad)}</button></td>
      <td><select class="kademe-sel">${kademeSecim}</select></td>
      <td><input class="il-input" type="text" value="${kacir(h.il || "")}" size="10"></td>
      <td><input class="kutuk-check" type="checkbox" ${h.kutuk_kaydi_var_mi ? "checked" : ""}></td>
      <td>${kacir(h.giris_email)}</td>
      <td>${kacir(h.iletisim_email || "—")}</td>
      <td>${kacir(h.telefon || "—")}</td>
      <td>${h.sifre_degistirmesi_gerekiyor
        ? '<span class="rozet-uyari">bekliyor</span>'
        : '<span class="rozet-ok">yapıldı</span>'}</td>
      <td><button class="btn btn-secondary btn-mini kaydet-btn" data-id="${h.id}">Kaydet</button></td>
    `;
    tbody.appendChild(tr);
  }
}

function kacir(deger) {
  if (deger === null || deger === undefined) return "";
  const d = document.createElement("div");
  d.textContent = deger;
  return d.innerHTML;
}

el("hakemTbody").addEventListener("click", async (e) => {
  const karneBtn = e.target.closest(".karne-btn");
  if (karneBtn) {
    await karneGoster(karneBtn.dataset.id, karneBtn.dataset.ad);
    return;
  }

  const kaydetBtn = e.target.closest(".kaydet-btn");
  if (kaydetBtn) {
    const id = kaydetBtn.dataset.id;
    const tr = kaydetBtn.closest("tr");
    const kademe = tr.querySelector(".kademe-sel").value;
    const il = tr.querySelector(".il-input").value.trim() || null;
    const kutuk = tr.querySelector(".kutuk-check").checked;

    kaydetBtn.disabled = true;
    kaydetBtn.textContent = "Kaydediliyor…";

    const { error } = await sb.from("hakemler").update({
      kademe, il, kutuk_kaydi_var_mi: kutuk,
    }).eq("id", id);

    kaydetBtn.disabled = false;
    kaydetBtn.textContent = error ? "Hata!" : "Kaydedildi ✓";
    setTimeout(() => { kaydetBtn.textContent = "Kaydet"; }, 1800);

    const kayit = tumHakemler.find((h) => h.id === id);
    if (kayit && !error) { kayit.kademe = kademe; kayit.il = il; kayit.kutuk_kaydi_var_mi = kutuk; }
  }
});

async function karneGoster(hakemId, adSoyad) {
  el("karneBaslik").textContent = `${adSoyad} — karne`;
  goster("karneKart", true);
  el("karneKart").scrollIntoView({ behavior: "smooth", block: "start" });

  const { data, error } = await sb
    .from("hakem_puanlari")
    .select("*")
    .eq("hakem_id", hakemId)
    .order("yarisma_tarihi", { ascending: false });

  const tbody = el("karneTbody");
  if (error || !data || data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">Kayıt yok.</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map((s) => `
    <tr>
      <td>${kacir(s.yarisma_adi)}</td>
      <td>${kacir(s.yarisma_tarihi)}</td>
      <td>${kacir(s.yarisma_yeri)}</td>
      <td>${kacir(s.kategori_adi)}</td>
      <td>${kacir(s.round)}</td>
      <td>${s.puan ?? "—"}</td>
    </tr>
  `).join("");
}

el("karneKapat").addEventListener("click", () => goster("karneKart", false));

el("arama").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLocaleUpperCase("tr-TR");
  const filtreli = q
    ? tumHakemler.filter((h) => h.ad_soyad.toLocaleUpperCase("tr-TR").includes(q))
    : tumHakemler;
  tabloCiz(filtreli);
});

el("girisForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  el("girisHata").hidden = true;
  const email = el("girisEmail").value.trim();
  const sifre = el("girisSifre").value;

  const { error } = await sb.auth.signInWithPassword({ email, password: sifre });
  if (error) {
    el("girisHata").textContent = "Giriş başarısız: e-posta ya da şifre hatalı.";
    el("girisHata").hidden = false;
    return;
  }
  await mhkMi();
});

el("cikisBtn").addEventListener("click", async () => {
  await sb.auth.signOut();
  el("girisForm").reset();
  ekranGoster("giris");
});

baslat();
