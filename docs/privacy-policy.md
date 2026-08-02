# Política de privacidade — Seixo

**Última atualização: 2 de agosto de 2026**

> Este ficheiro é a fonte/rascunho de revisão. A versão publicada (com
> páginas também em inglês e espanhol) vive no repositório público
> separado `Xeixos-corp/Seixo-Legal` (GitHub Pages) — mantém as duas em
> sincronia manualmente se este texto for alterado.

Esta política descreve, de forma exata e verificável em relação ao
código-fonte real da app, que dados a app Seixo recolhe, quem mais tem
acesso a eles, durante quanto tempo, e como podes pedir a sua eliminação.

Responsável pelo tratamento de dados: Bruno, developer individual da app
Seixo. Contacto: **seixo.app@proton.me**.

## O que a app recolhe

- **Uma identidade anónima**: ao usares a app pela primeira vez, é criado
  um identificador aleatório (UUID) para ti, sem necessidade de número de
  telefone, email, ou nome. Não pedimos nem guardamos nenhum destes dados.
- **Uma chave pública de identidade** (parte do protocolo de cifra Signal)
  — usada para estabelecer conversas cifradas. É só uma chave pública,
  nunca a tua chave privada, que nunca sai do teu telemóvel.
- **Chaves públicas temporárias (prekeys)** — usadas uma vez para iniciar
  uma conversa contigo, depois apagadas.
- **A que conversas pertences** (um identificador opaco de canal, e quem
  mais está nesse canal) — o mínimo indispensável para o servidor saber a
  quem entregar as mensagens.
- **O conteúdo das mensagens, sempre cifrado** — o servidor nunca vê o
  texto de nenhuma mensagem. Também não guardamos quem enviou cada
  mensagem numa coluna separada (a identidade do remetente só existe
  dentro do próprio conteúdo cifrado).
- **A lista de contactos que bloqueaste** — visível só para ti, nunca
  partilhada com mais ninguém.
- **Metadados de ligação inevitáveis** (endereço IP, hora do pedido) — como
  em qualquer serviço online, a infraestrutura do servidor vê isto ao
  nível da rede.

A app pede acesso à **câmara** só para ler códigos QR ao adicionar um
contacto — a imagem da câmara nunca é enviada nem guardada em lado
nenhum, é processada inteiramente no teu telemóvel.

**O que não recolhemos, de todo**: número de telefone, email (exceto se
tu próprio nos escreveres um para suporte), nome, lista de contactos do
telemóvel, localização, publicidade ou identificadores de publicidade, e
não usamos nenhum SDK de análise, rastreio ou publicidade de terceiros.

## Durante quanto tempo guardamos os dados

- Mensagens: apagadas automaticamente do servidor ao fim do temporizador
  que escolheres por conversa (entre 30 segundos e 1 semana),
  independentemente de teres aberto a app ou não.
- Chaves temporárias não usadas: apagadas ao fim de 30 dias.
- Canais de conversa nunca usados: apagados ao fim de 7 dias.
- A tua identidade e lista de bloqueados: mantidas enquanto a tua conta
  existir.

## Quem mais tem acesso aos teus dados

- **A outra pessoa na conversa** — só ela consegue decifrar e ler o
  conteúdo, no dispositivo dela.
- **A infraestrutura que aloja o serviço** (atualmente Supabase Inc.) —
  vê os metadados de ligação e o conteúdo cifrado (ilegível sem a chave,
  que nunca lhes é entregue), como qualquer fornecedor de infraestrutura
  de qualquer serviço online.
- **Ninguém mais.** Não vendemos, alugamos, nem partilhamos dados com
  publicidade, redes sociais, ou terceiros de qualquer tipo.

## Os teus direitos

- **Eliminar a tua conta e todos os dados**: disponível a qualquer
  momento em Definições → "Eliminar conta e todos os dados", dentro da
  própria app. Isto apaga a tua identidade, chaves, conversas iniciadas e
  lista de bloqueados do servidor, e também limpa os dados guardados no
  teu dispositivo.
- **Aceder, corrigir ou pedir uma cópia dos teus dados**: escreve para
  seixo.app@proton.me.
- Se estiveres na União Europeia, estes direitos correspondem aos direitos
  de acesso, retificação, apagamento e portabilidade previstos no RGPD.

## Segurança

As mensagens são cifradas ponta-a-ponta (protocolo Signal — X3DH/PQXDH e
Double Ratchet, através da biblioteca oficial `libsignal` do Signal). As
tuas chaves de sessão e de identidade ficam cifradas em repouso no teu
dispositivo, protegidas pelo Keychain (iOS) ou Keystore (Android). Isto
não é uma garantia absoluta — nenhuma app pode proteger-te se o teu
próprio dispositivo estiver comprometido, ou se alguém fotografar o ecrã
com outro aparelho.

## Menores de idade

A app não é dirigida a crianças e não pedimos, conscientemente, dados de
menores de idade. Não temos atualmente um mecanismo de verificação de
idade.

## Alterações a esta política

Se esta política mudar de forma significativa, isso será refletido nesta
página com a data de atualização revista.

## Contacto

Dúvidas, pedidos relacionados com os teus dados, ou denúncias:
**seixo.app@proton.me**
