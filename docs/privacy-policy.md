# Política de privacidade — Seixo

**Última atualização: 25 de setembro de 2026**

> Este ficheiro é a fonte de revisão. A versão publicada (com páginas também
> em inglês e espanhol) vive no repositório público separado
> `Xeixos-corp/Seixo-Legal` (GitHub Pages). As quatro versões são geradas
> a partir do mesmo texto, para não se desencontrarem.

Esta política descreve, de forma exata e verificável em relação ao código-fonte real da app, que dados a app Seixo recolhe, quem mais tem acesso a eles, durante quanto tempo, e como podes pedir a sua eliminação.

Responsável pelo tratamento de dados: Bruno, developer individual da app Seixo. Contacto: **seixo.app@proton.me**.

## Em resumo

- Não pedimos número de telefone, nome, email nem acesso aos teus contactos.
- O servidor nunca consegue ler as tuas mensagens: são cifradas no teu telemóvel antes de saírem. A única excepção é uma mensagem que alguém denuncie — quem a recebeu escolhe mostrá-la.
- Quase tudo o que o servidor guarda apaga-se sozinho — dizemos abaixo quando.
- Não usamos publicidade, análise nem rastreio de terceiros.

## O que o servidor guarda

**Sobre a tua conta:**

- **Um identificador aleatório**, criado quando abres a app pela primeira vez. Não está ligado a nenhum dado teu.
- **A tua chave pública de identidade e chaves públicas temporárias** (protocolo Signal), para outras pessoas poderem iniciar conversas cifradas contigo. As chaves privadas nunca saem do teu telemóvel.
- **A data do último uso** — só o dia, nunca a hora — para podermos apagar contas abandonadas.
- **A lista de pessoas que bloqueaste**, visível só para ti.
- **Um token de notificações** do teu telemóvel e os textos genéricos que o teu telemóvel escolheu mostrar (por exemplo, «Tens uma mensagem nova.»). Nunca incluem o conteúdo nem quem enviou.

**Sobre as tuas conversas:**

- **Que conversas existem e quem pertence a cada uma** e, nos grupos, quem é o dono. É o mínimo para o servidor saber a quem entregar cada mensagem.
- **As mensagens, sempre cifradas.** De cada uma, o servidor vê a conversa a que pertence, a hora exata, o tamanho e se deve gerar notificação — nunca o conteúdo, a não ser que alguém denuncie essa mensagem (ver «Denúncias»).
- **Quem enviou:** numa conversa a dois, **não fica guardado na nossa base de dados**. Mas o servidor sabe quem és no momento em que envias, e os registos do alojamento guardam durante **24 horas** que a tua conta enviou algo àquela hora — o que permite, nesse período, saber quem enviou cada mensagem. Ao fim de 24 horas essa ligação desaparece. **Num grupo, o servidor consegue ver quem enviou cada mensagem** enquanto essa mensagem existir, porque quem a recebe precisa de saber com que chave a decifrar.
- **Os nomes dos grupos e os nomes que dás aos contactos** nunca chegam ao servidor em texto legível.

**Sobre as fotografias que envias:**

- **Cada fotografia é cifrada no teu telemóvel** com uma chave feita só para ela, e guardada como um ficheiro com o nome da mensagem a que pertence. A chave viaja dentro da mensagem cifrada: o servidor nunca a tem e não consegue abrir o ficheiro.
- **Do ficheiro, o servidor vê:** o tamanho — arredondado para cima, para não revelar o tamanho real da fotografia —, quando foi guardado e **quando foi descarregado** pela última vez. Esta última informação é quase um aviso de leitura: diz, aproximadamente, quando a outra pessoa recebeu a fotografia. Não a conseguimos impedir, porque é escrita pelo serviço de armazenamento; existe apenas enquanto o ficheiro existir.
- **Na base de dados, não fica registado quem enviou o ficheiro.** O serviço de armazenamento tenta guardá-lo; nós apagamo-lo antes de ser gravado. (Os registos do alojamento, como para as mensagens, guardam-no durante 24 horas.)
- **Antes de sair do telemóvel, a fotografia é refeita** sem a localização, o modelo do telemóvel, a data e os outros dados que as fotografias costumam trazer. A app verifica o resultado e **recusa enviar** se algum desses dados tiver ficado.

**Só se criares uma cópia de segurança:**

- **Um endereço e uma palavra-passe derivados das tuas 12 palavras de recuperação**, para poderes voltar à mesma conta noutro telemóvel. O endereço termina em `@seixo.invalid`: não é um email real, não recebe correio e não revela nada sobre ti. A palavra-passe é guardada em forma irreversível.
- **O ficheiro da cópia não fica connosco.** Fica onde tu o guardares, e só abre com as tuas 12 palavras, que nunca recebemos.

## Endereços IP

Como qualquer serviço na internet, o servidor vê o endereço IP de onde te ligas. O que fazemos com isso:

**Na nossa base de dados**, onde temos poder para agir:

- O serviço de autenticação regista o IP e o tipo de dispositivo em cada sessão. **Apagamos esses dois campos a cada minuto.**
- O registo de auditoria da autenticação é apagado ao fim de **uma hora**.

**Nos registos do alojamento**, onde não temos:

Antes de um pedido chegar ao nosso código, a camada de entrada do fornecedor regista-o. Esse registo guarda, **durante 24 horas**:

- o endereço IP;
- o país, a cidade e o código postal aproximados de onde te ligas;
- o teu fornecedor de acesso à internet;
- uma impressão digital técnica do dispositivo — a forma como o teu telemóvel negoceia a ligação cifrada, que não é o mesmo que um identificador teu, mas distingue aparelhos;
- e, na maioria dos pedidos, o identificador da conta que o fez.

Não escrevemos esse registo, não lhe podemos tocar e não o podemos apagar mais cedo. Ao fim de 24 horas desaparece. Dizemo-lo por inteiro porque durante essas horas existe, no alojamento, uma ligação possível entre uma conta e um sítio — e essa é exactamente a informação que o resto desta política se esforça por não criar.

A app não esconde o teu IP. Se isso for importante para ti, usa uma VPN ou Tor.

## Permissões do telemóvel

- **Câmara**: para ler o código QR de um contacto e para tirares fotografias que decides enviar. Um código QR é lido no telemóvel e nunca é enviado nem guardado; uma fotografia só sai se a enviares, cifrada.
- **Fotografias**: nenhum acesso à tua galeria. Quando escolhes uma fotografia para enviar, é o próprio iPhone que te mostra a galeria e entrega à app apenas a que escolheste.
- **Microfone**: só para gravares mensagens de voz, quando carregas no botão. A gravação é cifrada no telemóvel antes de sair.
- **Face ID**: só para desbloquear a app, se ativares o bloqueio. É tratado pelo próprio sistema do telemóvel; nada sai do aparelho.
- **Notificações**: para saberes que chegou uma mensagem.

## O que não recolhemos

Número de telefone, nome, email real (exceto se nos escreveres para suporte), lista de contactos do telemóvel, localização, fotografias e identificadores de publicidade. Não usamos nenhum SDK de análise, rastreio ou publicidade.

## Durante quanto tempo guardamos os dados

- **Mensagens**: apagadas do servidor quando acaba o temporizador que escolheres — entre 30 segundos e 1 semana, para a conversa ou só para uma mensagem — mesmo que ninguém abra a app.
- **Mensagens de voz**: no servidor, no máximo **24 horas**, ou menos se o temporizador for mais curto. Quem não abrir a app nesse prazo não as recebe.
- **Fotografias**: no servidor, no máximo **24 horas**, ou menos se o temporizador for mais curto, e são apagadas cerca de um minuto depois da mensagem a que pertencem. Quem não abrir a app nesse prazo não as recebe. No telemóvel de quem as recebe, duram o tempo que o temporizador da conversa indicar.
- **Conversas**: uma conversa que nunca chegou a ter uma mensagem é apagada ao fim de **7 dias**. Uma conversa que já foi usada fica no servidor enquanto existirem as contas de quem a tem — mesmo depois de todas as mensagens terem expirado — para não desaparecer só por ter estado em silêncio.
- **Chaves temporárias nunca usadas**: 30 dias.
- **Contas**: apagadas ao fim de **6 meses sem abrires a app**, com tudo o que lhes pertence. Uma cópia de segurança dessa conta deixa de funcionar.
- **Lista de bloqueados, token de notificações e credenciais da cópia de segurança**: enquanto a conta existir.
- **Denúncias**: 90 dias. A marca de conta suspensa ou expulsa: enquanto a conta existir.
- **Endereços IP**: ver a secção acima.

## Quem mais tem acesso aos teus dados

- **As pessoas da conversa** — só elas conseguem decifrar o conteúdo, nos telemóveis delas.
- **Supabase Inc.**, que aloja a base de dados, o servidor e os ficheiros cifrados das fotografias na União Europeia (Paris). Tem acesso aos dados descritos acima e ao conteúdo cifrado, que não consegue ler, bem como ao conteúdo das mensagens denunciadas. É uma empresa norte-americana: os servidores estão na Europa, mas a empresa que os opera está sujeita à lei dos Estados Unidos, e um pedido legal feito lá pode alcançá-la. O que existiria para entregar é exactamente o que está descrito nesta política — texto cifrado que ninguém fora da conversa consegue abrir, e metadados mínimos que se apagam sozinhos nos prazos indicados acima.
- **Expo (650 Industries, Inc.) e Apple**, que encaminham as notificações até ao teu telemóvel. Recebem o token e o texto genérico da notificação — nunca o conteúdo nem o remetente.
- **Proton AG**, só se nos escreveres para seixo.app@proton.me.
- **Resend (Resend, Inc.)**, que envia ao programador o email de aviso de cada denúncia. Esse email diz apenas que chegou uma denúncia, quantas pessoas denunciaram a conta e se ela está suspensa — nunca o texto denunciado nem identificadores.
- **Ninguém mais.** Não vendemos, alugamos nem partilhamos dados com publicidade, redes sociais ou quaisquer outros terceiros.

## Denúncias

Podes denunciar uma mensagem ou uma pessoa. É a **única forma de o conteúdo de uma mensagem chegar ao servidor em texto legível**, e só acontece porque quem a recebeu decide mostrá-la.

- **Uma denúncia guarda:** quem denunciou, a conta denunciada, a conversa, e a mensagem denunciada: o texto, ou a própria fotografia ou mensagem de voz, que quem denuncia escolhe enviar. Numa conversa a dois, isto revela também quem enviou essa mensagem, algo que o servidor normalmente não guarda.
- **Quem a vê:** só o programador, numa página a que se chega pela ligação do email de aviso. O email em si diz apenas que chegou uma denúncia — nunca o conteúdo nem os identificadores. Uma fotografia ou mensagem de voz denunciada fica num espaço privado do servidor, e a página só a mostra através de uma ligação que expira em 10 minutos.
- **Durante quanto tempo:** a denúncia é apagada **90 dias** depois de ser feita.
- **O que pode acontecer à conta denunciada:** se três pessoas diferentes a denunciarem, fica suspensa automaticamente até ser analisada. Se a denúncia se confirmar, a conta é expulsa. Uma conta suspensa ou expulsa fica marcada no servidor enquanto existir, e é a única que consegue ver essa marca.

## Os teus direitos

- **Eliminar a tua conta e todos os dados**: a qualquer momento, em Definições → «Eliminar conta e todos os dados». Apaga do servidor a tua identidade, chaves, participação em conversas, lista de bloqueados, token de notificações e credenciais da cópia de segurança, e limpa os dados do teu telemóvel. As mensagens que já enviaste continuam cifradas até o temporizador as apagar, e qualquer cópia de segurança que tenhas guardado deixa de funcionar.
- **Aceder, corrigir ou pedir uma cópia dos teus dados**: escreve para seixo.app@proton.me. Como não sabemos quem és, podemos pedir-te o ID que aparece na app para encontrar os dados.
- Se estiveres na União Europeia, estes direitos correspondem aos direitos de acesso, retificação, apagamento e portabilidade previstos no RGPD.

## Segurança

As mensagens são cifradas ponta-a-ponta com o protocolo Signal (PQXDH e Double Ratchet), através da biblioteca oficial `libsignal`. As tuas chaves ficam cifradas no telemóvel, protegidas pelo Keychain (iOS) ou Keystore (Android), e as chaves temporárias de sessão são renovadas a cada 2 dias. Isto não é uma garantia absoluta: nenhuma app te protege se o teu próprio telemóvel estiver comprometido, ou se alguém fotografar o ecrã com outro aparelho.

## Menores de idade

A app é só para maiores de **18 anos**, como dizem os termos de utilização. Não pedimos, conscientemente, dados de menores de idade. Não temos um mecanismo de verificação de idade.

## Alterações a esta política

Se esta política mudar de forma significativa, isso será refletido nesta página com a data de atualização revista.

## Contacto

Dúvidas, pedidos relacionados com os teus dados, ou denúncias: **seixo.app@proton.me**
