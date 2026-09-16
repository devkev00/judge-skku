#!/usr/bin/env bash
# 공유 상태 확인: 서비스 상태와 현재 공유 주소를 출력한다.
# 사용: bash share_status.sh        (주소만 필요하면: bash share_status.sh --url)
URL=$(journalctl --user -u referee-share-tunnel -o cat --no-pager 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1)
if [ "$1" = "--url" ]; then echo "${URL}"; exit 0; fi
for unit in referee-share-server referee-share-tunnel; do
  printf "%-22s %s\n" "$unit" "$(systemctl --user is-active "$unit" 2>/dev/null)"
done
echo "공유 주소: ${URL:-(아직 없음. 터널이 뜨는 중이거나 인터넷 연결을 확인하세요)}"
echo "재시작:   systemctl --user restart referee-share-tunnel   (주소가 바뀝니다)"
echo "끄기:     systemctl --user stop referee-share-tunnel referee-share-server"
