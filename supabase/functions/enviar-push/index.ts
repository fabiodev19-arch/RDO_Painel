// supabase/functions/enviar-push/index.ts
//
// Função que roda FORA do banco (Supabase Edge Function, ambiente Deno) --
// é a única peça que conhece a chave PRIVADA do VAPID, necessária pra
// assinar e enviar a notificação push de verdade pro navegador do usuário.
// O painel chama isso via fetch() depois de devolver uma atividade.
//
// Implantação (rode no terminal, com o Supabase CLI já instalado):
//   npx supabase functions deploy enviar-push
//   npx supabase secrets set VAPID_PUBLIC_KEY="..."
//   npx supabase secrets set VAPID_PRIVATE_KEY="..."
//
// As chaves NÃO ficam escritas aqui de propósito: este arquivo mora em
// repositório público. Os valores estão em SEGREDOS_LOCAIS.md, na raiz do
// workspace, com os comandos prontos pra copiar. O par foi trocado em
// 2026-09-07 -- se você tem um comando antigo salvo em algum lugar com as
// chaves escritas, ele está desatualizado, não use.
//
// SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY já ficam
// disponíveis automaticamente pra toda Edge Function, não precisa configurar.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

webpush.setVapidDetails(
  "mailto:contato@gtmprestadora.com.br",
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

interface CorpoRequisicao {
  usuario_id?: string;
  titulo?: string;
  corpo?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método não permitido." }), { status: 405 });
  }

  // Exige chamador autenticado (não anon) -- mesma trava usada nas RPCs do
  // banco. Isso evita que alguém sem login dispare notificações à toa.
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace("Bearer ", "");
  if (!jwt) {
    return new Response(JSON.stringify({ error: "Não autorizado." }), { status: 401 });
  }

  const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await supabaseAuth.auth.getUser(jwt);
  if (userError || !userData?.user) {
    return new Response(JSON.stringify({ error: "Sessão inválida." }), { status: 401 });
  }

  let body: CorpoRequisicao;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Corpo da requisição inválido." }), { status: 400 });
  }

  const usuarioId = body.usuario_id;
  if (!usuarioId) {
    return new Response(JSON.stringify({ error: "usuario_id é obrigatório." }), { status: 400 });
  }

  // Usa a chave de serviço aqui (não a anon) pra poder ler push_subscriptions
  // de qualquer usuário -- essa tabela é bloqueada até pra authenticated
  // (só o dono enxergaria a própria, e aqui o painel precisa notificar
  // OUTRA pessoa, não a si mesmo).
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: inscricoes, error: dbError } = await supabaseAdmin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("usuario_id", usuarioId);

  if (dbError) {
    return new Response(JSON.stringify({ error: dbError.message }), { status: 500 });
  }
  if (!inscricoes || inscricoes.length === 0) {
    // Não é erro -- a pessoa pode nunca ter aceitado notificações no
    // aparelho dela. A devolução já foi salva no banco de qualquer jeito;
    // ela também vai ver isso na checagem ativa ao abrir o PWA.
    return new Response(JSON.stringify({ enviados: 0, motivo: "usuário sem inscrição de push" }), { status: 200 });
  }

  let enviados = 0;
  const idsParaRemover: string[] = [];

  await Promise.all(
    inscricoes.map(async (sub: { id: string; endpoint: string; p256dh: string; auth: string }) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ titulo: body.titulo || "GTM RDO", corpo: body.corpo || "" })
        );
        enviados++;
      } catch (err) {
        // 404/410 = inscrição morta (desinstalou o app, trocou de aparelho
        // sem gerar uma nova, etc.) -- limpa pra não tentar de novo à toa.
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          idsParaRemover.push(sub.id);
        }
      }
    })
  );

  if (idsParaRemover.length > 0) {
    await supabaseAdmin.from("push_subscriptions").delete().in("id", idsParaRemover);
  }

  return new Response(
    JSON.stringify({ enviados, total: inscricoes.length }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
