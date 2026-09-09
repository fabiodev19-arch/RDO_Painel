// supabase/functions/enviar-push/index.ts
//
// Função que roda FORA do banco (Supabase Edge Function, ambiente Deno) --
// é a única peça que conhece a chave PRIVADA do VAPID, necessária pra
// assinar e enviar a notificação push de verdade pro navegador do usuário.
// O painel chama isso via fetch() depois de devolver uma atividade.
//
// Implantação -- rode a partir de Painel/. Não precisa de Deno nem de Docker
// instalados: o CLI via npx traz o runtime (o aviso "Docker is not running" no
// deploy é inofensivo, Docker só serve pra rodar a função localmente).
//
//   npx supabase login                       # uma vez, abre o navegador
//   npx supabase secrets set --env-file supabase/.env
//   npx supabase functions deploy enviar-push --project-ref ogmovdwcoxfoemutqugk
//
// Os secrets vão por --env-file, e não na linha de comando, pra chave privada
// não ficar no histórico do shell nem na lista de processos. O supabase/.env é
// ignorado pelo git; o modelo sem valores está em supabase/.env.example.
//
// As chaves NÃO ficam escritas aqui de propósito: este arquivo mora em
// repositório público. Os valores estão em SEGREDOS_LOCAIS.md, na raiz do
// workspace. O par foi trocado em 2026-09-07 -- se você tem um comando antigo
// salvo em algum lugar com as chaves escritas, ele está desatualizado.
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

// ---------------------------------------------------------------------------
// CORS -- sem isto a função é inalcançável a partir do painel.
// ---------------------------------------------------------------------------
// O painel roda em github.io e chama supabase.co: origem diferente. Como a
// requisição leva Authorization e Content-Type, o navegador manda antes um
// preflight OPTIONS. A primeira versão desta função respondia 405 a ele (só
// aceitava POST), e o navegador abortava o POST antes de enviá-lo.
//
// O efeito era enganoso: no painel a devolução salvava normalmente e o toast
// dizia sucesso -- só a notificação sumia. E `curl` não reproduz o problema,
// porque preflight é coisa de navegador. Só apareceu ao ler os logs da função
// e ver um OPTIONS 405 no lugar do POST esperado (2026-09-08).
//
// A origem é conferida contra uma lista, em vez de devolver "*", porque com
// credencial no header o certo é dizer exatamente quem pode chamar. Origem
// desconhecida não recebe cabeçalho de permissão e o navegador barra.
const ORIGENS_PERMITIDAS = [
  "https://fabiodev19-arch.github.io",
];

function cabecalhosCors(req: Request): Record<string, string> {
  const origem = req.headers.get("Origin") ?? "";
  const permitida = ORIGENS_PERMITIDAS.includes(origem);
  return {
    "Access-Control-Allow-Origin": permitida ? origem : ORIGENS_PERMITIDAS[0],
    // apikey e authorization são os que o supabase-js/painel envia; sem eles
    // declarados aqui o preflight falha mesmo respondendo 204.
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function responder(req: Request, corpo: unknown, status: number): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...cabecalhosCors(req), "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Primeiro nome de quem vai receber a notificação
// ---------------------------------------------------------------------------
// Chamar a pessoa pelo nome muda o que a notificação comunica: "Fabio,
// apontamento devolvido" é recado para ELE; "Apontamento devolvido" é aviso
// de sistema, que se ignora na tela bloqueada.
//
// Quem monta é o servidor, não o painel. O painel poderia mandar o nome
// pronto, mas aí seria um dado vindo do cliente decidindo o que a outra pessoa
// lê -- o mesmo motivo pelo qual as RPCs recalculam em vez de confiar no
// payload (BOAS_PRATICAS.md §2).
//
// Duas fontes, nesta ordem:
//   1. user_metadata.nome, quando cadastrado -- sai correto e acentuado.
//   2. o local-part do e-mail (fabio.romero@... -> "Fabio") -- funciona hoje,
//      sem depender de cadastro nenhum, mas vem sem acento.
// Sem nenhuma das duas, a notificação sai sem nome em vez de sair errada.
function primeiroNomeDe(email: string | undefined, metadata: Record<string, unknown> | undefined): string {
  function capitalizar(bruto: string): string {
    const limpo = bruto.trim();
    if (!limpo) return "";
    return limpo.charAt(0).toLocaleUpperCase("pt-BR") + limpo.slice(1).toLocaleLowerCase("pt-BR");
  }

  const nomeCadastrado = typeof metadata?.nome === "string" ? metadata.nome as string : "";
  if (nomeCadastrado.trim()) {
    return capitalizar(nomeCadastrado.trim().split(/\s+/)[0]);
  }

  const local = (email ?? "").split("@")[0];
  if (!local) return "";
  // fabio.romero / fabio_romero / fabio-romero -> "fabio"
  const primeiro = local.split(/[._-]/)[0];
  // Login genérico do tipo "equipe01" vira "Equipe01" -- estranho, mas melhor
  // do que inventar um nome. Só descarta o que é puro número.
  if (!primeiro || /^\d+$/.test(primeiro)) return "";
  return capitalizar(primeiro);
}

Deno.serve(async (req: Request) => {
  // O preflight tem que ser respondido ANTES da checagem de método, senão cai
  // no 405 e a chamada real nunca acontece.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cabecalhosCors(req) });
  }

  if (req.method !== "POST") {
    return responder(req, { error: "Método não permitido." }, 405);
  }

  // Exige chamador autenticado (não anon) -- mesma trava usada nas RPCs do
  // banco. Isso evita que alguém sem login dispare notificações à toa.
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace("Bearer ", "");
  if (!jwt) {
    return responder(req, { error: "Não autorizado." }, 401);
  }

  const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await supabaseAuth.auth.getUser(jwt);
  if (userError || !userData?.user) {
    return responder(req, { error: "Sessão inválida." }, 401);
  }

  let body: CorpoRequisicao;
  try {
    body = await req.json();
  } catch {
    return responder(req, { error: "Corpo da requisição inválido." }, 400);
  }

  const usuarioId = body.usuario_id;
  if (!usuarioId) {
    return responder(req, { error: "usuario_id é obrigatório." }, 400);
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
    return responder(req, { error: dbError.message }, 500);
  }
  if (!inscricoes || inscricoes.length === 0) {
    // Não é erro -- a pessoa pode nunca ter aceitado notificações no
    // aparelho dela. A devolução já foi salva no banco de qualquer jeito;
    // ela também vai ver isso na checagem ativa ao abrir o PWA.
    return responder(req, { enviados: 0, motivo: "usuário sem inscrição de push" }, 200);
  }

  // Busca o destinatário para personalizar o título. Falhar aqui não pode
  // impedir o envio: sem nome a notificação ainda é útil, e perder o aviso
  // por causa de um enfeite seria o pior dos mundos.
  let primeiroNome = "";
  try {
    const { data: dadosUsuario } = await supabaseAdmin.auth.admin.getUserById(usuarioId);
    primeiroNome = primeiroNomeDe(
      dadosUsuario?.user?.email,
      dadosUsuario?.user?.user_metadata as Record<string, unknown> | undefined
    );
  } catch (err) {
    console.error("não consegui ler o nome do destinatário: " + String(err));
  }

  // O painel manda o motivo como `corpo`. O título é montado aqui.
  const tituloBase = body.titulo || "Apontamento devolvido";
  const tituloFinal = primeiroNome
    ? `${primeiroNome}, ${tituloBase.charAt(0).toLocaleLowerCase("pt-BR")}${tituloBase.slice(1)}`
    : tituloBase;

  let enviados = 0;
  const idsParaRemover: string[] = [];

  await Promise.all(
    inscricoes.map(async (sub: { id: string; endpoint: string; p256dh: string; auth: string }) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ titulo: tituloFinal, corpo: body.corpo || "" })
        );
        enviados++;
      } catch (err) {
        // Sem este log, uma falha de envio é invisível: a função responde 200
        // com enviados=0 e não há como saber se foi chave VAPID errada, se o
        // servidor de push recusou, ou se a inscrição morreu. Vai pro log da
        // função, não pra resposta -- o painel não precisa desse detalhe, mas
        // quem for investigar precisa.
        const status = (err as { statusCode?: number })?.statusCode;
        const corpoErro = (err as { body?: string })?.body ?? String(err);
        console.error(
          `falha ao enviar push: status=${status ?? "?"} endpoint=${sub.endpoint.slice(0, 60)} detalhe=${corpoErro}`
        );

        // 404/410 = inscrição morta (desinstalou o app, trocou de aparelho
        // sem gerar uma nova, etc.) -- limpa pra não tentar de novo à toa.
        if (status === 404 || status === 410) {
          idsParaRemover.push(sub.id);
        }
      }
    })
  );

  if (idsParaRemover.length > 0) {
    await supabaseAdmin.from("push_subscriptions").delete().in("id", idsParaRemover);
  }

  // Esta é a resposta que o painel lê -- sem os cabeçalhos CORS o navegador
  // bloqueia a leitura mesmo com o envio tendo dado certo.
  console.log(`push: enviados=${enviados} de ${inscricoes.length} inscrição(ões)`);
  return responder(req, { enviados, total: inscricoes.length }, 200);
});
